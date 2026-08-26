/**
 * Full and partial index construction.
 *
 * Two passes, because call resolution needs to know what every file exports
 * before it can resolve anything:
 *   pass 1 — parse each file, store nodes/imports, accumulate raw call sites
 *   pass 2 — build the export/name indexes, resolve calls and heritage, write edges
 *
 * A partial build (incremental update) reparses only the delta, then rewrites
 * every edge from persisted raw calls so unchanged files still re-resolve
 * against the new export index.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { throwIfAborted } from '../abort.ts'
import type { GraphDb, GraphEdge, GraphNode, ImportRow, NodeKind } from '../db.ts'
import { type Lang, langFilter, langForPath } from '../parse/loader.ts'
import { type CodeGraphConfig, DEFAULT_MAX_FILE_BYTES } from '../config.ts'
import { noiseFor } from '../parse/noise.ts'
import { clearProbeCache, clearSourceCache, takeCachedSource } from '../parse/imports/caches.ts'
import { type ResolverConfig, resolverConfigFor } from '../parse/imports/config.ts'
import { goTypeFile } from '../parse/imports/go.ts'
import { expandImports, resolveSpecifier } from '../parse/imports/resolve.ts'
import { rustTypeFile } from '../parse/imports/rust.ts'
import {
  buildClassMembers,
  buildExportIndex,
  buildNameIndex,
  type ExportIndex,
  type NameIndex,
  propagateReExports,
  resolveCalls,
  resolveHeritage,
} from '../parse/resolve-calls.ts'
import { type FileExtract, extractFile } from '../parse/extract.ts'
import { flag, nullable, num, optional, type SqlRow, str } from '../row.ts'
import { gitChangedSince, gitDirtyPaths, gitState, listFiles } from './gitscan.ts'

/**
 * Index-shaping limits resolved from user settings.
 *
 * Passed down rather than read from a module-level constant so one process can
 * hold two repositories under different settings, and so a settings change is a
 * new value rather than a mutation nothing observes.
 */
export interface IndexLimits {
  /** Files larger than this are skipped: they are generated, not authored. */
  maxFileBytes: number
  /** Path-to-language mapping, narrowed to the families a user enabled. */
  langOf: (path: string) => Lang | undefined
  /** User exclusions, additive over the built-in ignore list. */
  exclude: readonly string[]
}

/** Limits used when no configuration has been resolved (tests, bare calls). */
export const DEFAULT_INDEX_LIMITS: IndexLimits = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  langOf: langForPath,
  exclude: [],
}

/**
 * Project a resolved settings section onto the limits the build layer needs.
 * @param config - the resolved `code-graph` section.
 * @returns Limits ready to hand to a build.
 */
export function indexLimits(config: CodeGraphConfig): IndexLimits {
  return {
    maxFileBytes: config.maxFileBytes,
    langOf: langFilter(config.languages),
    exclude: config.exclude,
  }
}

/** Meta key recording which enumeration strategy produced the stored index. */
const FILE_SOURCE_KEY = 'file_source'

export interface BuildProgress {
  parsed: number
  total: number
  phase: 'scanning' | 'parsing' | 'purging' | 'resolving' | 'done'
}

export interface BuildResult {
  files: number
  nodes: number
  edges: number
  durationMs: number
  skipped: number
}

/** Hash file content for change detection. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Index a specific set of files into the graph.
 * @param db - the open graph database.
 * @param repoRoot - absolute repository root.
 * @param paths - repo-relative paths to index.
 * @param config - import resolver configuration.
 * @param onProgress - optional progress callback.
 * @returns Counts describing what was written.
 */
export async function indexFiles(
  db: GraphDb,
  repoRoot: string,
  paths: string[],
  config: ResolverConfig,
  onProgress?: (p: BuildProgress) => void,
  opts: {
    skipPurge?: boolean | undefined
    signal?: AbortSignal | undefined
    limits?: IndexLimits | undefined
  } = {},
): Promise<BuildResult> {
  const started = Date.now()
  const skipPurge = opts.skipPurge === true
  const limits = opts.limits ?? DEFAULT_INDEX_LIMITS
  // Only the count is needed: pass 2 reads everything back from the database,
  // so holding each file's extract would retain the whole repository's parse
  // output for the length of the build.
  let indexed = 0
  let skipped = 0
  /** Buffered pass-1 writes, flushed in batches to amortize WAL commits. */
  let batch: Array<() => void> = []
  const flush = (): void => {
    if (batch.length === 0) return
    const work = batch
    batch = []
    db.transaction(() => {
      for (const w of work) w()
    })
  }

  // ---- pass 1: parse and store structure -------------------------------
  for (const [i, rel] of paths.entries()) {
    throwIfAborted(opts.signal)
    const written = await indexOneFile(db, repoRoot, rel, config, skipPurge, limits)
    if (!written) {
      skipped += 1
      continue
    }
    batch.push(written.write)
    if (written.parsed) indexed += 1
    else skipped += 1

    if (batch.length >= 500) flush()
    if (onProgress && i % 200 === 0) {
      onProgress({ parsed: i, total: paths.length, phase: 'parsing' })
    }
  }
  flush()
  // Whatever the config loaders read and pass 1 did not want back — every
  // source outside the delta, on an incremental — is dead weight from here on.
  clearSourceCache()

  // ---- pass 2: resolve edges against the whole graph --------------------
  // Always global: stored raw calls from unchanged files must re-resolve
  // against the updated export index, or incremental updates leave stale
  // incoming CALLS and miss new exports.
  onProgress?.({ parsed: paths.length, total: paths.length, phase: 'resolving' })
  rewriteAllEdges(db)

  onProgress?.({ parsed: paths.length, total: paths.length, phase: 'done' })

  const nodeTotal = (db.db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c
  const edgeTotal = (db.db.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c

  return {
    files: indexed,
    nodes: nodeTotal,
    edges: edgeTotal,
    durationMs: Date.now() - started,
    skipped,
  }
}

/** One file's pass-1 contribution: a buffered write, plus whether it parsed. */
interface FileWrite {
  write: () => void
  parsed: boolean
}

/**
 * Parse one file and buffer everything pass 1 stores for it.
 *
 * Returns `undefined` when the file earns no row at all — unknown language,
 * unreadable, not a regular file, or over the configured size limit. A file that read
 * but failed to parse still gets a row carrying its `parseError`, so change
 * detection can fingerprint it and not retry until it changes; `parsed` is
 * false there and the caller counts it as skipped.
 *
 * Returns the write rather than performing it: `indexFiles` batches them so a
 * run of files commits as one transaction.
 */
async function indexOneFile(
  db: GraphDb,
  repoRoot: string,
  rel: string,
  config: ResolverConfig,
  skipPurge: boolean,
  limits: IndexLimits,
): Promise<FileWrite | undefined> {
  const lang = limits.langOf(rel)
  if (!lang) return undefined

  const abs = join(repoRoot, rel)
  let source: string
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(abs)
    if (!stat.isFile() || stat.size > limits.maxFileBytes) return undefined
    source = takeCachedSource(abs, Math.floor(stat.mtimeMs), stat.size)
      ?? readFileSync(abs, 'utf8')
  } catch {
    return undefined
  }

  let extract: FileExtract | undefined
  let parseError: string | null = null
  try {
    const go = config.go
    const rust = config.rust
    extract = await extractFile(
      rel,
      lang,
      source,
      (go || rust)
        ? {
          typeFile: (from, name) => {
            if (from.endsWith('.go') && go) return goTypeFile(go, from, name)
            if (from.endsWith('.rs') && rust) return rustTypeFile(rust, from, name)
            return undefined
          },
        }
        : undefined,
    )
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }

  const fileRow = {
    path: rel,
    hash: hashContent(source),
    lang,
    mtimeMs: Math.floor(stat.mtimeMs),
    size: stat.size,
    parsedAt: Date.now(),
    parseError: extract ? null : parseError ?? 'no tree produced',
  }

  if (!extract) {
    return { write: () => db.writeFile(fileRow, [], [], [], { skipPurge }), parsed: false }
  }

  const importRows = collectImportRows(rel, extract, config)

  // Nodes and imports land now; edges wait for the global index.
  const nodesForFile = extract.nodes
  const raw = {
    calls: extract.calls.map((c) => ({
      fromQname: c.fromQname,
      name: c.name,
      receiver: c.receiver,
      isConstruction: c.isConstruction ? 1 : 0,
      line: c.line,
    })),
    heritage: extract.heritage.map((h) => ({
      kind: h.kind,
      src: h.src,
      dst: h.dst,
      line: h.line,
    })),
  }
  return {
    write: () => db.writeFile(fileRow, nodesForFile, [], importRows, { skipPurge }, raw),
    parsed: true,
  }
}

/**
 * Every import row one file stores: its own imports with specifiers resolved,
 * the rows language-specific expansion adds, and its re-exports.
 *
 * Re-exports are recorded as import rows so an import through a barrel can be
 * followed to the real definition instead of falling back to a global-name
 * guess. Barrels are pervasive in package-per-dir repos.
 */
function collectImportRows(rel: string, extract: FileExtract, config: ResolverConfig): ImportRow[] {
  const importRows: ImportRow[] = []
  for (const imp of extract.imports) {
    const target = imp.resolvedPath ?? (imp.spec ? resolveSpecifier(imp.spec, rel, config) : undefined)
    importRows.push({ ...imp, resolvedPath: target ?? imp.resolvedPath ?? null })
  }
  for (const extra of expandImports(rel, importRows, config)) {
    importRows.push(extra)
  }
  for (const re of extract.reExports) {
    importRows.push({
      path: rel,
      spec: re.spec,
      resolvedPath: resolveSpecifier(re.spec, rel, config) ?? null,
      line: 0,
      kind: 're-export-name',
      name: re.name,
      imported: re.orig,
    })
  }
  for (const spec of extract.starReExports) {
    importRows.push({
      path: rel,
      spec,
      resolvedPath: resolveSpecifier(spec, rel, config) ?? null,
      line: 0,
      kind: 're-export-star',
      name: '*',
    })
  }
  return importRows
}

function loadAllNodes(db: GraphDb): GraphNode[] {
  const allNodes = db.db
    .prepare('SELECT qname, kind, name, path, lang, line_start, line_end, parent, signature, exported, is_test, loc FROM nodes')
    .all() as SqlRow[]
  return allNodes.map((r) => ({
    qname: str(r, 'qname'),
    kind: str(r, 'kind') as NodeKind,
    name: str(r, 'name'),
    path: str(r, 'path'),
    lang: str(r, 'lang'),
    lineStart: num(r, 'line_start'),
    lineEnd: num(r, 'line_end'),
    parent: nullable(r, 'parent'),
    signature: nullable(r, 'signature'),
    exported: num(r, 'exported'),
    isTest: num(r, 'is_test'),
    loc: num(r, 'loc'),
  }))
}

/**
 * Wipe and rewrite every edge from persisted extracts + the current node index.
 *
 * Incremental pass-1 only reparses the delta; callers in unchanged files still
 * have to re-resolve against the new export/name indexes, so this pass is
 * always global.
 */
function rewriteAllEdges(db: GraphDb): void {
  const files = loadFileInputs(db)
  const indexes = buildResolutionIndexes(db, files)
  writeEdges(db, files, indexes)
  linkTests(db)
}

/**
 * One file's resolution input — the shape `resolveCalls` and `resolveHeritage`
 * take, minus the whole-graph indexes.
 *
 * Pass 1 keeps no extract in memory, so `extract` here is reassembled out of
 * SQL rather than carried across the two passes. Its `reExports` /
 * `starReExports` are empty by design: pass 1 folded those into the stored
 * import rows, and resolution reads them back through `exportIndex`.
 */
interface FileInput {
  path: string
  extract: FileExtract
  resolvedImports: Map<string, string>
  fileNodes: GraphNode[]
  noise: ReadonlySet<string>
}

/** The whole-graph lookups every file resolves against. */
interface ResolutionIndexes {
  exportIndex: ExportIndex
  nameIndex: NameIndex
  classMembers: Map<string, Set<string>>
  classParents: Map<string, string[]>
  kinds: Map<string, NodeKind>
}

/** Read the persisted graph back out of SQL, one entry per file that has nodes. */
function loadFileInputs(db: GraphDb): FileInput[] {
  const nodesByPath = new Map<string, GraphNode[]>()
  for (const n of loadAllNodes(db)) {
    const list = nodesByPath.get(n.path)
    if (list) list.push(n)
    else nodesByPath.set(n.path, [n])
  }

  const importsByPath = groupByPath(
    db,
    'SELECT path, spec, resolved_path, kind, name, imported, line FROM imports',
    (r, path): ImportRow => ({
      path,
      spec: str(r, 'spec'),
      resolvedPath: nullable(r, 'resolved_path'),
      line: num(r, 'line'),
      kind: str(r, 'kind'),
      name: nullable(r, 'name'),
      imported: nullable(r, 'imported'),
    }),
  )

  const callsByPath = groupByPath(
    db,
    'SELECT path, from_qname, name, receiver, is_construction, line FROM raw_calls',
    (r): FileExtract['calls'][number] => ({
      fromQname: str(r, 'from_qname'),
      name: str(r, 'name'),
      receiver: nullable(r, 'receiver'),
      isConstruction: flag(r, 'is_construction'),
      line: num(r, 'line'),
    }),
  )

  const heritageByPath = groupByPath(
    db,
    'SELECT path, kind, src, dst, line FROM raw_heritage',
    (r, path): GraphEdge => ({
      kind: str(r, 'kind') as GraphEdge['kind'],
      src: str(r, 'src'),
      dst: str(r, 'dst'),
      path,
      line: num(r, 'line'),
      resolved: 0,
      confidence: 1,
    }),
  )

  const files: FileInput[] = []
  for (const [path, fileNodes] of nodesByPath) {
    const imports = importsByPath.get(path) ?? []
    const resolvedImports = new Map<string, string>()
    for (const imp of imports) {
      if (imp.resolvedPath && imp.spec) resolvedImports.set(imp.spec, imp.resolvedPath)
    }
    const locals = new Map<string, string>()
    for (const n of fileNodes) {
      if (n.kind === 'file') continue
      if (!locals.has(n.name)) locals.set(n.name, n.qname)
    }
    files.push({
      path,
      fileNodes,
      resolvedImports,
      // Per-language, and resolution takes it as data — see `parse/noise.ts`.
      noise: noiseFor(langForPath(path)),
      extract: {
        nodes: fileNodes,
        imports,
        calls: callsByPath.get(path) ?? [],
        heritage: heritageByPath.get(path) ?? [],
        locals,
        reExports: [],
        starReExports: [],
      },
    })
  }
  return files
}

/** Run one query and bucket its rows by their `path` column, preserving row order. */
function groupByPath<T>(
  db: GraphDb,
  sql: string,
  map: (row: SqlRow, path: string) => T,
): Map<string, T[]> {
  const byPath = new Map<string, T[]>()
  for (const r of db.db.prepare(sql).all() as SqlRow[]) {
    const path = str(r, 'path')
    const list = byPath.get(path)
    if (list) list.push(map(r, path))
    else byPath.set(path, [map(r, path)])
  }
  return byPath
}

/**
 * Build the global indexes call resolution consults.
 *
 * `classParents` is the ordering constraint: `this.m()` resolves against
 * inherited members, so the class-parent map has to exist before any file's
 * calls resolve. Only heritage feeds it, and heritage does not depend on it —
 * so that pass resolves heritage alone rather than running full call
 * resolution over every file to throw the calls away.
 */
function buildResolutionIndexes(db: GraphDb, files: FileInput[]): ResolutionIndexes {
  const nodes = files.flatMap((f) => f.fileNodes)

  const exportIndex = buildExportIndex(nodes)
  const reExportRows = (
    db.db
      .prepare(
        `SELECT path, resolved_path, name, imported FROM imports
         WHERE kind IN ('re-export-name', 're-export-star')
           AND resolved_path IS NOT NULL AND name IS NOT NULL`,
      )
      .all() as SqlRow[]
  ).map((r) => ({
    path: str(r, 'path'),
    target: str(r, 'resolved_path'),
    name: str(r, 'name'),
    imported: optional(r, 'imported'),
  }))
  propagateReExports(exportIndex, reExportRows)

  for (const r of db.db
    .prepare(`SELECT path, name FROM imports WHERE kind = 'default-export' AND name IS NOT NULL`)
    .all() as SqlRow[]) {
    const filePath = str(r, 'path')
    const qname = str(r, 'name')
    let bucket = exportIndex.get(filePath)
    if (!bucket) {
      bucket = new Map()
      exportIndex.set(filePath, bucket)
    }
    bucket.set('default', qname)
  }

  const nameIndex = buildNameIndex(nodes)
  const classMembers = buildClassMembers(nodes)
  const kinds = new Map<string, NodeKind>()
  for (const n of nodes) kinds.set(n.qname, n.kind)

  const classParents = new Map<string, string[]>()
  for (const f of files) {
    for (const e of resolveHeritage({
      path: f.path,
      extract: f.extract,
      resolvedImports: f.resolvedImports,
      exportIndex,
      nameIndex,
      classMembers,
      kinds,
      noise: f.noise,
    })) {
      if (e.kind !== 'INHERITS' || e.resolved !== 1) continue
      const list = classParents.get(e.src) ?? []
      list.push(e.dst)
      classParents.set(e.src, list)
    }
  }

  return { exportIndex, nameIndex, classMembers, classParents, kinds }
}

/**
 * Replace the edge table: resolved calls, plus the two structural edge kinds
 * that need no resolution.
 *
 * One transaction over the whole repository, so a concurrent reader never
 * observes the graph mid-rewrite.
 */
function writeEdges(db: GraphDb, files: FileInput[], indexes: ResolutionIndexes): void {
  const insEdge = db.db.prepare(
    'INSERT INTO edges(kind, src, dst, path, line, resolved, confidence) VALUES(?,?,?,?,?,?,?)',
  )

  db.transaction(() => {
    db.db.exec('DELETE FROM edges')
    for (const f of files) {
      const edges: GraphEdge[] = resolveCalls({
        path: f.path,
        extract: f.extract,
        resolvedImports: f.resolvedImports,
        ...indexes,
        noise: f.noise,
      })
      for (const n of f.fileNodes) {
        if (n.kind === 'file') continue
        edges.push({
          kind: 'CONTAINS',
          src: n.parent ?? f.path,
          dst: n.qname,
          path: f.path,
          line: n.lineStart,
          resolved: 1,
          confidence: 1,
        })
      }
      const importTargets = new Set<string>()
      for (const imp of f.extract.imports) {
        if (imp.resolvedPath && imp.resolvedPath !== f.path) importTargets.add(imp.resolvedPath)
      }
      for (const target of importTargets) {
        edges.push({
          kind: 'IMPORTS',
          src: f.path,
          dst: target,
          path: f.path,
          line: 0,
          resolved: 1,
          confidence: 1,
        })
      }
      const seen = new Set<string>()
      for (const e of edges) {
        const key = `${e.kind}\u0000${e.src}\u0000${e.dst}`
        if (seen.has(key)) continue
        seen.add(key)
        insEdge.run(e.kind, e.src, e.dst, e.path, e.line, e.resolved, e.confidence)
      }
    }
  })
}

/**
 * Derive TESTED_BY edges from calls that cross the test boundary.
 *
 * Deduplicated to one edge per (production symbol, test symbol) pair — a test
 * calling the same function twenty times is still one coverage fact — and
 * limited to confidently resolved calls, because the 0.5 global-unique-name
 * fallback produced mostly noise here (14.9k weak vs 6.1k solid edges).
 */
function linkTests(db: GraphDb): void {
  db.db.exec(`
    DELETE FROM edges WHERE kind = 'TESTED_BY';
    INSERT INTO edges(kind, src, dst, path, line, resolved, confidence)
    SELECT 'TESTED_BY', e.src, e.dst, MIN(e.path), MIN(e.line), 1, MAX(e.confidence)
    FROM edges e
    JOIN nodes caller ON caller.qname = e.src
    JOIN nodes callee ON callee.qname = e.dst
    WHERE e.kind = 'CALLS' AND e.resolved = 1 AND e.confidence >= 0.8
      AND caller.is_test = 1 AND callee.is_test = 0
    GROUP BY e.dst, e.src
  `)
}

/**
 * Build the complete index for a repository from scratch.
 * @param db - the open graph database.
 * @param repoRoot - absolute repository root.
 * @param onProgress - optional progress callback.
 * @returns Counts describing the finished index.
 */
export async function fullBuild(
  db: GraphDb,
  repoRoot: string,
  onProgress?: (p: BuildProgress) => void,
  signal?: AbortSignal,
  limits: IndexLimits = DEFAULT_INDEX_LIMITS,
): Promise<BuildResult> {
  throwIfAborted(signal)
  onProgress?.({ parsed: 0, total: 0, phase: 'scanning' })
  clearProbeCache()
  clearSourceCache()
  const { files: all, source } = await listFiles(repoRoot, { exclude: limits.exclude, signal })
  const config = resolverConfigFor(repoRoot, all)
  const sources = all.filter((f) => limits.langOf(f) !== undefined)

  db.clearGraph()

  const result = await indexFiles(db, repoRoot, sources, config, onProgress, { skipPurge: true, signal, limits })

  const state = await gitState(repoRoot, signal)
  if (state.head) db.setMeta('head_commit', state.head)
  db.setMeta('built_at', String(Date.now()))
  db.setMeta('repo_root', repoRoot)
  db.setMeta(FILE_SOURCE_KEY, source)
  return result
}

/**
 * Re-index only the files known to have changed since the last build.
 *
 * Detects out-of-band changes (git working-tree modifications, new files,
 * deletions) and reconciles the index so the next query returns fresh data.
 *
 * Two-phase approach:
 *   phase 1 — purge deleted files, hash on-disk content for changed/new files
 *   phase 2 — re-parse and re-index the delta set, re-resolve all edges
 *
 * @param db - the open graph database.
 * @param repoRoot - absolute repository root.
 * @param dirtyPaths - repo-relative paths already marked dirty by the agent.
 * @param onProgress - optional progress callback.
 * @returns Counts describing the incremental rebuild.
 */
export async function incrementalBuild(
  db: GraphDb,
  repoRoot: string,
  dirtyPaths: string[],
  onProgress?: (p: BuildProgress) => void,
  signal?: AbortSignal,
  limits: IndexLimits = DEFAULT_INDEX_LIMITS,
): Promise<IncrementalResult> {
  throwIfAborted(signal)
  const started = Date.now()

  const storedHead = db.getMeta('head_commit') ?? null
  const state = await gitState(repoRoot, signal)
  const headChanged = Boolean(state.head && storedHead && state.head !== storedHead)

  const gitPaths = await gitDirtyPaths(repoRoot, signal)
  const delta = new Set<string>(dirtyPaths)
  if (gitPaths) {
    for (const p of gitPaths) delta.add(p)
  }
  let since: string[] | undefined
  if (headChanged && storedHead) {
    since = await gitChangedSince(repoRoot, storedHead, signal)
    if (since) {
      for (const p of since) delta.add(p)
    }
  }

  const { files: currentFiles, source: fileSource } = await listFiles(repoRoot, { exclude: limits.exclude, signal })
  const currentSet = new Set(currentFiles)

  // Absence from the listing only means "deleted" when the listing enumerates
  // the same universe the index was built from. `listFiles` silently falls back
  // to a directory walk whenever git fails — timeout, missing binary, index lock
  // — and that walk's universe is different: it skips IGNORED_DIRS and every
  // dot-directory, and includes gitignored files. Trusting it after a git-backed
  // build purges files that are still on disk. So: git is authoritative, a walk
  // is trustworthy only for an index a walk itself produced, and anything else
  // falls back to on-disk existence, which holds whoever produced the listing.
  const storedSource = db.getMeta(FILE_SOURCE_KEY)
  const listingIsTrusted = fileSource === 'git' || storedSource === 'walk'
  // Only ever upgrade the recorded source. Writing 'walk' here would make the
  // next run trust a fallback listing and re-open the purge hole.
  if (fileSource === 'git' && storedSource !== 'git') db.setMeta(FILE_SOURCE_KEY, fileSource)

  const fingerprints = db.fileFingerprints()
  const deleted = new Set<string>()
  for (const path of fingerprints.keys()) {
    throwIfAborted(signal)
    if (listingIsTrusted) {
      if (!currentSet.has(path)) deleted.add(path)
    } else if (!existsSync(join(repoRoot, path))) {
      deleted.add(path)
    }
  }

  const toReparse = new Set<string>()
  for (const path of delta) {
    const abs = join(repoRoot, path)
    // Tracked-but-deleted worktree files still appear in `git ls-files --cached`.
    if (!existsSync(abs)) {
      if (fingerprints.has(path)) deleted.add(path)
      continue
    }
    if (limits.langOf(path) !== undefined) toReparse.add(path)
  }
  // Same caveat for discovery: an untrusted listing would add files the real
  // universe excludes (gitignored build output, say). Missing a new file until
  // the next trustworthy listing is recoverable; indexing junk is not.
  if (listingIsTrusted) {
    for (const path of currentFiles) {
      if (!fingerprints.has(path) && limits.langOf(path) !== undefined) {
        toReparse.add(path)
      }
    }
  }

  // Git-unavailable (or HEAD diff failed): compare stored fingerprints.
  // Size mismatch → reparse. mtime mismatch → hash to skip touch-only noise.
  // Hash is the content fingerprint; mtime/size are the cheap filter.
  const gitUnavailable = !state.isRepo || gitPaths === undefined
  const headDiffFailed = headChanged && since === undefined
  if (gitUnavailable || headDiffFailed) {
    for (const [path, fp] of fingerprints) {
      throwIfAborted(signal)
      if (deleted.has(path) || limits.langOf(path) === undefined) continue
      try {
        const abs = join(repoRoot, path)
        const st = statSync(abs)
        if (st.size !== fp.size) {
          toReparse.add(path)
          continue
        }
        if (Math.floor(st.mtimeMs) === fp.mtimeMs) continue
        const text = readFileSync(abs, 'utf8')
        if (hashContent(text) !== fp.hash) toReparse.add(path)
      } catch {
        // Missing on disk is handled as deleted above.
      }
    }
  }

  if (deleted.size === 0 && toReparse.size === 0) {
    if (state.head) db.setMeta('head_commit', state.head)
    return {
      filesIndexed: 0,
      filesDeleted: 0,
      durationMs: Date.now() - started,
    }
  }

  let filesDeleted = 0
  if (deleted.size > 0) {
    onProgress?.({ parsed: 0, total: deleted.size, phase: 'purging' })
    db.transaction(() => {
      for (const path of deleted) db.purgeFile(path)
    })
    filesDeleted = deleted.size
  }

  let filesIndexed = 0
  if (toReparse.size > 0) {
    clearProbeCache()
    clearSourceCache()
    // Reuse the last config unless something it is derived from moved. Rebuilding
    // it reads every .java/.go/.rs file in the repository — more work than the
    // one-file re-index it is preparing for.
    const changed = new Set<string>([...delta, ...toReparse, ...deleted])
    const config = resolverConfigFor(repoRoot, currentFiles, changed)
    const result = await indexFiles(db, repoRoot, [...toReparse], config, onProgress, { signal, limits })
    filesIndexed = result.files
  } else if (filesDeleted > 0) {
    // Deletion still invalidates incoming CALLS to the removed qnames.
    onProgress?.({ parsed: 0, total: 0, phase: 'resolving' })
    rewriteAllEdges(db)
  }

  if (state.head) db.setMeta('head_commit', state.head)
  db.setMeta('built_at', String(Date.now()))

  return {
    filesIndexed,
    filesDeleted,
    durationMs: Date.now() - started,
  }
}

export interface IncrementalResult {
  filesIndexed: number
  filesDeleted: number
  durationMs: number
}
