/**
 * SQLite storage for the code graph.
 *
 * Uses the built-in `node:sqlite` DatabaseSync (stable as of Node 26; the
 * experimental warning it emitted on Node 25 is gone). The graph is two
 * string-keyed tables joined on qualified names, so an unresolved edge target
 * can dangle harmlessly as a bare name instead of forcing a fabricated node.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalizeRepoRoot } from './repo.ts'

/** Bump to force a drop-and-rebuild; cheaper than migrations at this scale. */
export const SCHEMA_VERSION = 8

export type NodeKind =
  | 'file' | 'function' | 'method' | 'class'
  | 'interface' | 'type' | 'enum' | 'var'

export type EdgeKind =
  | 'CALLS' | 'IMPORTS' | 'INHERITS' | 'IMPLEMENTS'
  | 'CONTAINS' | 'REFERENCES' | 'TESTED_BY'

export interface GraphNode {
  qname: string
  kind: NodeKind
  name: string
  path: string
  lang: string
  lineStart: number
  lineEnd: number
  parent: string | null
  signature: string | null
  exported: number
  isTest: number
  loc: number
}

export interface GraphEdge {
  kind: EdgeKind
  src: string
  dst: string
  path: string
  line: number
  /** 1 when `dst` is a real qname; 0 when it is an unresolved bare name. */
  resolved: number
  confidence: number
}

export interface ImportRow {
  path: string
  spec: string
  resolvedPath: string | null
  line: number
  kind: string
  /**
   * Local binding or exposed re-export name. For a `default-export` row, the
   * defining symbol's qname.
   */
  name?: string | null
  /**
   * Name in the source module: original identifier, `default`, or `*`.
   * Absent/null means it matches `name`.
   */
  imported?: string | null
}

export interface FileRow {
  path: string
  hash: string
  lang: string
  mtimeMs: number
  size: number
  parsedAt: number
  parseError: string | null
}

/** Unresolved call site persisted so incremental rebuilds can re-resolve globally. */
export interface RawCallRow {
  fromQname: string
  name: string
  receiver: string | null
  isConstruction: number
  line: number
}

/** Unresolved heritage clause persisted for global re-resolution. */
export interface RawHeritageRow {
  kind: EdgeKind
  src: string
  dst: string
  line: number
}

export interface FileExtractRows {
  calls: RawCallRow[]
  heritage: RawHeritageRow[]
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  lang       TEXT,
  mtime_ms   INTEGER,
  size       INTEGER,
  parsed_at  INTEGER,
  parse_error TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  qname      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  lang       TEXT,
  line_start INTEGER,
  line_end   INTEGER,
  parent     TEXT,
  signature  TEXT,
  exported   INTEGER DEFAULT 0,
  is_test    INTEGER DEFAULT 0,
  loc        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
  kind       TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  path       TEXT NOT NULL,
  line       INTEGER DEFAULT 0,
  resolved   INTEGER DEFAULT 0,
  confidence REAL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS imports (
  path          TEXT NOT NULL,
  spec          TEXT NOT NULL,
  resolved_path TEXT,
  line          INTEGER DEFAULT 0,
  kind          TEXT,
  name          TEXT,
  imported      TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_calls (
  path            TEXT NOT NULL,
  from_qname      TEXT NOT NULL,
  name            TEXT NOT NULL,
  receiver        TEXT,
  is_construction INTEGER NOT NULL DEFAULT 0,
  line            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raw_heritage (
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  src  TEXT NOT NULL,
  dst  TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_edges_dst_kind ON edges(dst, kind);
CREATE INDEX IF NOT EXISTS idx_edges_src_kind ON edges(src, kind);
CREATE INDEX IF NOT EXISTS idx_edges_path ON edges(path);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_path);
CREATE INDEX IF NOT EXISTS idx_imports_path ON imports(path);
CREATE INDEX IF NOT EXISTS idx_raw_calls_path ON raw_calls(path);
CREATE INDEX IF NOT EXISTS idx_raw_heritage_path ON raw_heritage(path);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qname, signature,
  content='nodes', content_rowid='rowid'
);
`

/**
 * Retract one `nodes_fts` entry.
 *
 * `nodes_fts` is an external-content table: FTS5 stores no copy of the indexed
 * text, so removing an entry means handing back the exact values indexed under
 * that rowid. `DELETE FROM nodes_fts WHERE …` scans the whole index and only
 * works while the matching `nodes` row still exists; this form is a direct hit
 * and stays correct regardless.
 */
const FTS_DELETE_SQL =
  `INSERT INTO nodes_fts(nodes_fts, rowid, name, qname, signature) VALUES('delete',?,?,?,?)`

/** A `nodes` row in the shape `nodes_fts` indexed it under. */
interface IndexedNode {
  rowid: number
  name: string
  qname: string
  signature: string | null
}

/**
 * The write path's prepared statements, prepared once per connection.
 *
 * `writeFile` and `purgeFile` both run once per file, so preparing their
 * fourteen statements inline cost a re-compile per file — measured 321ms of
 * `prepare` alone at full-build volume (2776 files x 8 statements).
 */
interface WriteStatements {
  insNode: StatementSync
  selNode: StatementSync
  delFts: StatementSync
  insFts: StatementSync
  insEdge: StatementSync
  insImport: StatementSync
  insFile: StatementSync
  insCall: StatementSync
  insHeritage: StatementSync
  selPurgeNodes: StatementSync
  delNodes: StatementSync
  delEdges: StatementSync
  delImports: StatementSync
  delCalls: StatementSync
  delHeritage: StatementSync
  delFile: StatementSync
}

/**
 * Resolve the on-disk location of a repository's graph database.
 * Keyed by a hash of the canonical repo path so the index lives entirely
 * outside the repository and survives clean checkouts.
 * @param dshHome - the DSH home directory.
 * @param repoRoot - canonical absolute path of the indexed repository.
 * @returns Absolute path of the SQLite database file.
 */
export function graphDbPath(dshHome: string, repoRoot: string): string {
  const key = createHash('sha256').update(canonicalizeRepoRoot(repoRoot)).digest('hex').slice(0, 16)
  return join(dshHome, 'storages', 'code-graph', key, 'graph.db')
}

/**
 * One repository's graph: its connection, schema, transactions and write path.
 *
 * Also owns the bookkeeping reads that belong to no query — `getMeta` and
 * `fileFingerprints`, which drive change detection and the schema check.
 *
 * Graph *queries* are deliberately not encapsulated. Each query module writes
 * its own SQL against the public `db` field (`query/overview.ts`, `find.ts`,
 * `impact.ts`, `relations.ts`, `resolve.ts` and `index/build.ts`, 27 `prepare`
 * sites between them), because every one of those statements exists to feed the
 * row-shaping and budgeting immediately below it: `queryEdges` and its
 * `RelationSections`, the impact BFS and its frontier, the overview aggregates
 * and their counts. Named methods here would split each query from its only
 * consumer and put the result types a module away from the SELECT that fills
 * them. `db` is exposed for exactly that — the split is intentional, not
 * unfinished.
 *
 * The prepared-statement bundle (`writeStatements`) covers the write path only.
 */
export class GraphDb {
  readonly db: DatabaseSync
  readonly repoRoot: string
  private inTransaction = false
  private stmts: WriteStatements | undefined

  private constructor(db: DatabaseSync, repoRoot: string) {
    this.db = db
    this.repoRoot = repoRoot
  }

  /**
   * Open (or create) the graph database for a repository.
   * A schema-version mismatch drops every table rather than migrating: a full
   * rebuild costs ~2s, which is cheaper than carrying migration code.
   * @param dbPath - absolute path of the database file, or ':memory:'.
   * @param repoRoot - canonical absolute path of the indexed repository.
   * @returns An initialized graph database handle.
   */
  static open(dbPath: string, repoRoot: string): GraphDb {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    }
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    const handle = new GraphDb(db, repoRoot)
    handle.ensureSchema()
    return handle
  }

  private ensureSchema(): void {
    const existing = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
      .get() as { name?: string } | undefined
    if (existing?.name) {
      const row = this.db
        .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
        .get() as { value?: string } | undefined
      if (row?.value !== String(SCHEMA_VERSION)) this.dropAll()
    }
    this.db.exec(SCHEMA_SQL)
    this.setMeta('schema_version', String(SCHEMA_VERSION))
  }

  private dropAll(): void {
    for (const t of ['nodes_fts', 'imports', 'edges', 'nodes', 'files', 'raw_calls', 'raw_heritage', 'meta']) {
      this.db.exec(`DROP TABLE IF EXISTS ${t}`)
    }
    // Cached statements are bound to the tables they were compiled against.
    // Today `dropAll` only runs from `ensureSchema`, before any write and so
    // before the bundle exists — but the invalidation is what makes that an
    // implementation detail rather than a precondition.
    this.stmts = undefined
  }

  /**
   * The write path's statement bundle, prepared on first use.
   *
   * Deliberately lazy: a read-only session (the four query tools) opens a
   * `GraphDb` too and never writes.
   * @returns The cached bundle, preparing it if this is the first write.
   */
  private writeStatements(): WriteStatements {
    return (this.stmts ??= {
      insNode: this.db.prepare(
        `INSERT INTO nodes(qname, kind, name, path, lang, line_start, line_end, parent, signature, exported, is_test, loc)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(qname) DO UPDATE SET
           kind=excluded.kind, name=excluded.name, path=excluded.path, lang=excluded.lang,
           line_start=excluded.line_start, line_end=excluded.line_end, parent=excluded.parent,
           signature=excluded.signature, exported=excluded.exported, is_test=excluded.is_test, loc=excluded.loc
         RETURNING rowid`,
      ),
      selNode: this.db.prepare('SELECT rowid, name, qname, signature FROM nodes WHERE qname = ?'),
      delFts: this.db.prepare(FTS_DELETE_SQL),
      insFts: this.db.prepare(
        'INSERT INTO nodes_fts(rowid, name, qname, signature) VALUES(?,?,?,?)',
      ),
      insEdge: this.db.prepare(
        'INSERT INTO edges(kind, src, dst, path, line, resolved, confidence) VALUES(?,?,?,?,?,?,?)',
      ),
      insImport: this.db.prepare(
        'INSERT INTO imports(path, spec, resolved_path, line, kind, name, imported) VALUES(?,?,?,?,?,?,?)',
      ),
      insFile: this.db.prepare(
        `INSERT INTO files(path, hash, lang, mtime_ms, size, parsed_at, parse_error)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET
           hash=excluded.hash, lang=excluded.lang, mtime_ms=excluded.mtime_ms,
           size=excluded.size, parsed_at=excluded.parsed_at, parse_error=excluded.parse_error`,
      ),
      insCall: this.db.prepare(
        'INSERT INTO raw_calls(path, from_qname, name, receiver, is_construction, line) VALUES(?,?,?,?,?,?)',
      ),
      insHeritage: this.db.prepare(
        'INSERT INTO raw_heritage(path, kind, src, dst, line) VALUES(?,?,?,?,?)',
      ),
      selPurgeNodes: this.db.prepare('SELECT rowid, name, qname, signature FROM nodes WHERE path = ?'),
      delNodes: this.db.prepare('DELETE FROM nodes WHERE path = ?'),
      delEdges: this.db.prepare('DELETE FROM edges WHERE path = ?'),
      delImports: this.db.prepare('DELETE FROM imports WHERE path = ?'),
      delCalls: this.db.prepare('DELETE FROM raw_calls WHERE path = ?'),
      delHeritage: this.db.prepare('DELETE FROM raw_heritage WHERE path = ?'),
      delFile: this.db.prepare('DELETE FROM files WHERE path = ?'),
    })
  }

  /**
   * Read one metadata value.
   * @param key - metadata key.
   * @returns The stored string, or undefined when absent.
   */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value
  }

  /**
   * Write one metadata value.
   * @param key - metadata key.
   * @param value - value to persist.
   */
  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /**
   * Remove every row belonging to one file, so it can be re-inserted cleanly.
   * This is the unit of incremental update: a changed file is purged and
   * re-parsed rather than diffed node by node.
   * @param path - repo-relative file path.
   */
  purgeFile(path: string): void {
    const st = this.writeStatements()
    const indexed = st.selPurgeNodes.all(path) as unknown as IndexedNode[]
    for (const r of indexed) st.delFts.run(r.rowid, r.name, r.qname, r.signature ?? '')
    st.delNodes.run(path)
    st.delEdges.run(path)
    st.delImports.run(path)
    st.delCalls.run(path)
    st.delHeritage.run(path)
    st.delFile.run(path)
  }

  /**
   * Empty every graph table ahead of a full rebuild.
   *
   * `nodes_fts` is cleared through FTS5's `delete-all` command: a plain
   * `DELETE FROM nodes_fts` reads each row's indexed values back from `nodes`,
   * which leaves stale index entries behind once `nodes` has been emptied.
   */
  clearGraph(): void {
    this.db.exec(`
      INSERT INTO nodes_fts(nodes_fts) VALUES('delete-all');
      DELETE FROM nodes;
      DELETE FROM edges;
      DELETE FROM imports;
      DELETE FROM files;
      DELETE FROM raw_calls;
      DELETE FROM raw_heritage;
    `)
  }

  /**
   * Run `work` inside a single transaction.
   *
   * Batching matters: a per-file transaction pays a WAL commit each time, which
   * dominated a full build (20s for 2.7k files) until the whole parse pass was
   * wrapped in one transaction.
   * @param work - callback performing the batched writes.
   * @returns Whatever `work` returns.
   */
  transaction<T>(work: () => T): T {
    if (this.inTransaction) return work()
    this.db.exec('BEGIN')
    this.inTransaction = true
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  /**
   * Insert one file's parse output atomically.
   * @param file - the file row including its content hash.
   * @param nodes - structural nodes extracted from the file.
   * @param edges - edges originating in the file.
   * @param imports - import records for later resolution.
   */
  writeFile(
    file: FileRow,
    nodes: GraphNode[],
    edges: GraphEdge[],
    imports: ImportRow[],
    opts: { skipPurge?: boolean } = {},
    raw: FileExtractRows = { calls: [], heritage: [] },
  ): void {
    const {
      insNode, selNode, delFts, insFts, insEdge, insImport, insFile, insCall, insHeritage,
    } = this.writeStatements()

    this.transaction(() => {
      // A full build writes into freshly emptied tables, where purging costs a
      // contentless-FTS scan per file (measured 5.2s across 2.7k files) and can
      // remove nothing. Incremental updates always purge.
      if (opts.skipPurge !== true) this.purgeFile(file.path)
      for (const n of nodes) {
        // The upsert's DO UPDATE path inserts no row, so `last_insert_rowid()`
        // would still hold an unrelated node's rowid and index this symbol's
        // tokens against that node — a search hit for text it does not contain.
        // Bind the row's own rowid instead, and retract the superseded entry
        // first so its old tokens do not linger.
        const prev = selNode.get(n.qname) as unknown as IndexedNode | undefined
        if (prev) delFts.run(prev.rowid, prev.name, prev.qname, prev.signature ?? '')
        const row = insNode.get(
          n.qname, n.kind, n.name, n.path, n.lang, n.lineStart, n.lineEnd,
          n.parent, n.signature, n.exported, n.isTest, n.loc,
        ) as unknown as { rowid: number } | undefined
        if (row) insFts.run(row.rowid, n.name, n.qname, n.signature ?? '')
      }
      for (const e of edges) {
        insEdge.run(e.kind, e.src, e.dst, e.path, e.line, e.resolved, e.confidence)
      }
      for (const i of imports) {
        insImport.run(
          i.path, i.spec, i.resolvedPath, i.line, i.kind, i.name ?? null, i.imported ?? null,
        )
      }
      for (const c of raw.calls) {
        insCall.run(file.path, c.fromQname, c.name, c.receiver, c.isConstruction, c.line)
      }
      for (const h of raw.heritage) {
        insHeritage.run(file.path, h.kind, h.src, h.dst, h.line)
      }
      insFile.run(
        file.path, file.hash, file.lang, file.mtimeMs, file.size, file.parsedAt, file.parseError,
      )
    })
  }

  /**
   * Read every known file's change-detection fingerprint.
   * @returns A map of repo-relative path to its stored hash/mtime/size.
   */
  fileFingerprints(): Map<string, { hash: string; mtimeMs: number; size: number }> {
    const rows = this.db.prepare('SELECT path, hash, mtime_ms, size FROM files').all() as Array<{
      path: string
      hash: string
      mtime_ms: number
      size: number
    }>
    const out = new Map<string, { hash: string; mtimeMs: number; size: number }>()
    for (const r of rows) out.set(r.path, { hash: r.hash, mtimeMs: r.mtime_ms, size: r.size })
    return out
  }

  /** Close the underlying database handle. */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // A checkpoint failure must never block plugin teardown.
    }
    this.db.close()
  }
}
