/**
 * Building the index a scenario measures against, and calling tools the way the
 * harness calls them.
 *
 * Two things this file is careful about.
 *
 * **A fresh index every run.** The database goes into a temp directory created
 * per run and is never reused, so no scenario silently measures a warm path it
 * did not mean to. `index-profile` is the one place that measures a warm path,
 * and it says so.
 *
 * **The tool-shaped result, not the query result.** `code_find` re-wraps its
 * query output and every tool has `freshness` spread onto it at registration
 * (`src/index.ts`). Measuring `findSymbols` directly would undercount every row
 * by the difference. So calls go through the specs, and the envelope is
 * reproduced here — the one piece of `src/index.ts` a benchmark has to imitate,
 * because it lives inside a Cordis `execute`.
 */
import { existsSync, statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphDb } from '../src/db.ts'
import { DEFAULT_BUDGET, DEFAULT_MAX_BUDGET, DEFAULT_MAX_FILE_BYTES, LANG_FAMILIES } from '../src/config.ts'
import { fullBuild, indexLimits } from '../src/index/build.ts'
import { clampBudget } from '../src/query/budget.ts'
import { graphToolSpecs } from '../src/tools/specs.ts'

/** Specs by wire name, so a scenario can name a tool as a string. */
const SPECS = new Map(graphToolSpecs.map((spec) => [spec.name, spec]))

/**
 * The settings a bench run indexes under.
 *
 * Stock defaults, deliberately: the numbers should describe the plugin as a user
 * gets it, not a configuration tuned to look good.
 * @param overrides - fields to replace.
 * @returns A resolved `code-graph` section.
 */
export function benchConfig(overrides = {}) {
  return {
    defaultBudget: DEFAULT_BUDGET,
    maxBudget: DEFAULT_MAX_BUDGET,
    exclude: [],
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    languages: [...LANG_FAMILIES],
    ...overrides,
  }
}

/**
 * Make the per-run index directory.
 * @returns An absolute path to a fresh temp directory.
 */
export function createIndexDir() {
  return mkdtemp(join(tmpdir(), 'cg-bench-index-'))
}

/**
 * Build a cold index over a repository.
 * @param repoDir - the checked-out repository.
 * @param options - where to put the database and what settings to build under.
 * @param options.indexDir - directory to hold the database.
 * @param options.name - a filename-safe repository name.
 * @param options.config - the resolved `code-graph` section.
 * @returns The open database, its path and size, and the build result.
 */
export async function buildIndex(repoDir, { indexDir, name, config = benchConfig() }) {
  const dbPath = join(indexDir, `${name}.db`)
  const db = GraphDb.open(dbPath, repoDir)
  const started = performance.now()
  const build = await fullBuild(db, repoDir, undefined, undefined, indexLimits(config))
  const elapsedMs = Math.round(performance.now() - started)
  return { db, dbPath, build, elapsedMs, dbBytes: dbFootprint(db, dbPath) }
}

/**
 * The index's real size on disk.
 *
 * Storage is WAL-journalled, so immediately after a build almost everything is
 * still in `-wal` and a bare `stat` of the database reports near zero — which is
 * how a 1.8 MB index comes to look like 0.0 MB in a table. Checkpoint first,
 * then count every file the index actually occupies.
 * @param db - the open graph.
 * @param dbPath - path to the database file.
 * @returns Total bytes across the database and its journal files.
 */
function dbFootprint(db, dbPath) {
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((p) => existsSync(p))
    .reduce((total, p) => total + statSync(p).size, 0)
}

/**
 * The freshness record the tool envelope spreads onto every result.
 *
 * A bench build is a full one over a clean checkout, so this is what the plugin
 * would report: ready, at the checked-out head, with nothing dirty. It is
 * included in the token count because a real caller pays for it on every call.
 * @param sha - the checked-out commit.
 * @returns A `Freshness` record.
 */
export function freshnessFor(sha) {
  return { status: 'ready', head: sha.slice(0, 8), dirtyFiles: 0, builtAt: 0, rebuiltFiles: 0, rebuiltDeleted: 0 }
}

/**
 * Call one tool exactly as the harness would, and hand back what the model sees.
 *
 * Mirrors the envelope in `src/index.ts`: guards first so bad input fails before
 * any work, then the clamped budget, then the spec's own `run`, then freshness.
 * A throw is left to the caller — a failed call is recorded as an error row, not
 * smoothed into a zero.
 * @param db - the open graph.
 * @param tool - the tool's wire name.
 * @param args - the call arguments, `max_tokens` included.
 * @param options - the budget limits and the freshness record to spread.
 * @param options.config - the resolved section supplying the budget limits.
 * @param options.freshness - the record to spread onto the result.
 * @returns `{ result, budget, elapsedMs }` where `result` is the serialised-shape value.
 */
export function callTool(db, tool, args, { config = benchConfig(), freshness } = {}) {
  const spec = SPECS.get(tool)
  if (!spec) throw new Error(`unknown tool: ${tool}`)
  spec.check?.(args)
  const budget = clampBudget(args.max_tokens, config)
  const started = performance.now()
  const value = spec.run(db, args, budget)
  const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000
  return { result: { ...value, freshness }, budget, elapsedMs }
}

/**
 * Every file the index actually covers, with its stored size.
 *
 * The realized set rather than the candidate set: a file the build skipped is
 * not something the graph can answer about, so counting it in a corpus baseline
 * would inflate the baseline with text no tool ever had.
 * @param db - the open graph.
 * @returns Rows of `{ path, size }`, ordered by path.
 */
export function indexedFiles(db) {
  // Raw SQL, as the test helpers do: the query layer exposes no file listing.
  return db.db
    .prepare('SELECT path, size FROM files ORDER BY path')
    .all()
    .map((r) => ({ path: String(r.path), size: Number(r.size) }))
}
