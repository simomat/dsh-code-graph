/**
 * Cheap orientation — the call an agent makes first.
 *
 * Modelled on the reference project's `get_minimal_context`: a compact summary
 * that also self-reports whether the index is usable, so the agent never acts
 * on a stale graph without knowing. With `focus` it narrows to one directory,
 * which is why architecture overview needs no separate tool.
 *
 * `focus` is a directory prefix and nothing else. A file path or a symbol name
 * matches no directory, and rather than report a repository of zero files as
 * `ready` it comes back `empty` saying so — see {@link overview}.
 */
import type { GraphDb } from '../db.ts'
import { num, type SqlRow, str } from '../row.ts'
import { fitRows } from './budget.ts'
import { pathPrefixLike } from './sql.ts'

export interface HubEntry {
  qname: string
  name: string
  path: string
  line: number
  kind: string
  /** Distinct callers; the centrality proxy. */
  callers: number
}

export interface ModuleEntry {
  dir: string
  files: number
  symbols: number
  /** Edges leaving this directory — a coupling proxy. */
  outbound: number
}

export interface OverviewResult {
  /** `empty` means the index holds nothing, or `focus` matched no directory. */
  status: 'ready' | 'empty'
  repoRoot: string
  focus: string | null
  totals: {
    files: number
    symbols: number
    edges: number
    tests: number
    /** Share of CALLS edges resolved to a definition, 0..1. */
    callResolution: number
  }
  languages: Array<{ lang: string; files: number }>
  modules: ModuleEntry[]
  hubs: HubEntry[]
  entryPoints: string[]
  next: string[]
  truncated: boolean
}

function scalar(db: GraphDb, sql: string, ...params: unknown[]): number {
  const row = db.db.prepare(sql).get(...(params as never[])) as SqlRow | undefined
  const first = row ? Object.values(row)[0] : 0
  return Number(first ?? 0)
}

/**
 * Compute the orientation summary.
 * @param db - the open graph database.
 * @param focus - optional directory prefix to narrow the summary to. Not a file
 *   path and not a symbol; either yields `status: 'empty'`.
 * @param budget - token budget for the variable-length sections.
 * @returns A compact, budget-bounded overview.
 */
export function overview(db: GraphDb, focus: string | undefined, budget: number): OverviewResult {
  const repoRoot = db.getMeta('repo_root') ?? db.repoRoot
  const indexedFiles = scalar(db, "SELECT COUNT(*) FROM nodes WHERE kind = 'file'")
  if (indexedFiles === 0) {
    return {
      status: 'empty',
      repoRoot,
      focus: focus ?? null,
      totals: { files: 0, symbols: 0, edges: 0, tests: 0, callResolution: 0 },
      languages: [],
      modules: [],
      hubs: [],
      entryPoints: [],
      next: ['The index is empty or still building; retry shortly.'],
      truncated: false,
    }
  }

  // A focus naming a directory scopes every count below it. Matching on
  // `<dir>/` avoids a sibling prefix (`src2/`) leaking into a `src` focus.
  const prefix = focus ? focus.replace(/\/+$/, '') : undefined
  const pathFilter = prefix ? pathPrefixLike(prefix) : '%'
  const like = " LIKE ? ESCAPE '\\'"

  const files = scalar(db, `SELECT COUNT(*) FROM nodes WHERE kind = 'file' AND path${like}`, pathFilter)

  // A focus that names a file or a symbol matches no path prefix, and every
  // count below would come back 0 under a `ready` status — indistinguishable
  // from an empty repository. Say what actually happened instead.
  if (prefix !== undefined && files === 0) {
    return {
      status: 'empty',
      repoRoot,
      focus: prefix,
      totals: { files: 0, symbols: 0, edges: 0, tests: 0, callResolution: 0 },
      languages: [],
      modules: [],
      hubs: [],
      entryPoints: [],
      next: [
        `No indexed files under "${prefix}" — \`focus\` is a directory prefix, not a file or symbol.`,
        'code_overview — drop `focus` to see the module layout and pick a directory from it',
        'code_find query="<name>" — locate a symbol without reading files',
      ],
      truncated: false,
    }
  }

  const symbols = scalar(
    db,
    `SELECT COUNT(*) FROM nodes WHERE kind != 'file' AND path${like}`,
    pathFilter,
  )
  const edges = scalar(db, `SELECT COUNT(*) FROM edges WHERE path${like}`, pathFilter)
  const tests = scalar(
    db,
    `SELECT COUNT(*) FROM nodes WHERE is_test = 1 AND kind != 'file' AND path${like}`,
    pathFilter,
  )
  const callsTotal = scalar(db, `SELECT COUNT(*) FROM edges WHERE kind = 'CALLS' AND path${like}`, pathFilter)
  const callsResolved = scalar(
    db,
    `SELECT COUNT(*) FROM edges WHERE kind = 'CALLS' AND resolved = 1 AND path${like}`,
    pathFilter,
  )

  const languages = (
    db.db
      .prepare(
        `SELECT lang, COUNT(*) AS files FROM nodes
         WHERE kind = 'file' AND path${like} GROUP BY lang ORDER BY files DESC`,
      )
      .all(pathFilter) as SqlRow[]
  ).map((r) => ({ lang: str(r, 'lang', 'unknown'), files: num(r, 'files') }))

  // Module layout: parent directories, capped at `depth` segments so a
  // `src/foo.ts` tree groups as `src` rather than as per-file "modules".
  const depth = prefix ? prefix.split('/').length + 1 : 2
  const filePaths = (
    db.db
      .prepare(`SELECT path FROM nodes WHERE kind = 'file' AND path${like}`)
      .all(pathFilter) as Array<{ path: string }>
  ).map((r) => r.path)
  const fileCounts = new Map<string, number>()
  for (const filePath of filePaths) {
    const parts = filePath.split('/')
    const dirParts = parts.length <= 1 ? ['.'] : parts.slice(0, -1)
    const dir = dirParts.slice(0, depth).join('/') || '.'
    fileCounts.set(dir, (fileCounts.get(dir) ?? 0) + 1)
  }
  const moduleRows = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)

  const modules: ModuleEntry[] = moduleRows.map(([dir, fileCount]) => ({
    dir,
    files: fileCount,
    symbols: scalar(
      db,
      `SELECT COUNT(*) FROM nodes WHERE kind != 'file' AND path${like}`,
      dir === '.' ? '%' : pathPrefixLike(dir),
    ),
    outbound: dir === '.'
      ? 0
      : scalar(
        db,
        `SELECT COUNT(*) FROM edges
         WHERE kind = 'IMPORTS' AND src${like} AND dst NOT${like}`,
        pathPrefixLike(dir),
        pathPrefixLike(dir),
      ),
  }))

  // Centrality counts only confidently resolved calls. The 0.5 global-unique-name
  // fallback otherwise dominates: a lone `map` helper in a script collected 1245
  // phantom callers from every unrelated `.map(...)` in the repository.
  const hubs: HubEntry[] = (
    db.db
      .prepare(
        `SELECT n.qname, n.name, n.path, n.line_start, n.kind, COUNT(DISTINCT e.src) AS callers
         FROM nodes n JOIN edges e
           ON e.dst = n.qname AND e.kind = 'CALLS' AND e.resolved = 1 AND e.confidence >= 0.8
         WHERE n.kind != 'file' AND n.is_test = 0 AND n.path${like}
         GROUP BY n.qname ORDER BY callers DESC LIMIT 15`,
      )
      .all(pathFilter) as SqlRow[]
  ).map((r) => ({
    qname: str(r, 'qname'),
    name: str(r, 'name'),
    path: str(r, 'path'),
    line: num(r, 'line_start'),
    kind: str(r, 'kind'),
    callers: num(r, 'callers'),
  }))

  // Entry points: files nothing else imports, excluding tests.
  const entryPoints = (
    db.db
      .prepare(
        `SELECT n.path FROM nodes n
         WHERE n.kind = 'file' AND n.is_test = 0 AND n.path${like}
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'IMPORTS' AND e.dst = n.path)
           AND EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'IMPORTS' AND e.src = n.path)
         ORDER BY n.path LIMIT 12`,
      )
      .all(pathFilter) as SqlRow[]
  ).map((r) => str(r, 'path'))

  const fittedModules = fitRows(modules, Math.floor(budget * 0.4), 0)
  const fittedHubs = fitRows(hubs, Math.floor(budget * 0.3), 0)

  const next: string[] = []
  if (fittedHubs.rows[0]) {
    next.push(`code_relations symbol="${fittedHubs.rows[0].name}" — inspect the most-called symbol`)
  }
  next.push('code_find query="<name>" — locate a symbol without reading files')
  next.push('code_impact paths=[...] — see what a change would affect')

  return {
    status: 'ready',
    repoRoot,
    focus: focus ?? null,
    totals: {
      files,
      symbols,
      edges,
      tests,
      callResolution: callsTotal === 0 ? 0 : Math.round((callsResolved / callsTotal) * 100) / 100,
    },
    languages,
    modules: fittedModules.rows,
    hubs: fittedHubs.rows,
    entryPoints,
    next,
    truncated: fittedModules.truncated || fittedHubs.truncated,
  }
}
