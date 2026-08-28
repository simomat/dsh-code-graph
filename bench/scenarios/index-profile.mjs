/**
 * Scenario E — the index itself.
 *
 * Not a token benchmark. It exists because the README bullet this harness was
 * built to retire names these specific numbers — full build time, database size,
 * node and edge counts, warm query latency, and the share of CALLS resolved —
 * and none of the token scenarios produce any of them. Replacing that bullet
 * while quietly dropping two thirds of what it promised would be its own small
 * dishonesty.
 *
 * This is the one place that measures a **warm** path, and it does so on
 * purpose: `code_find` and `code_overview` latency are only interesting once the
 * database is built, because that is the state an agent finds it in. The build
 * numbers beside them are the cold ones. Both are labelled.
 */
import { BUDGETS } from '../config.mjs'
import { callTool } from '../graph.mjs'
import { errorRow, makeRow } from '../rows.mjs'

/** Queries whose warm latency is worth a row, run repeatedly and taken at median. */
const WARM_QUERIES = [
  { tool: 'code_overview', args: {} },
  { tool: 'code_find', args: { query: 'get' } },
]

/** How many times a warm query is repeated before its median is taken. */
const REPEATS = 5

/**
 * The median of a list of numbers.
 * @param values - the samples.
 * @returns The median.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Run the scenario for one repository at one budget.
 * @param context - the shared per-repo run context.
 * @returns Rows, errors included.
 */
export function run(context) {
  const { db, budget, counter, base, freshness, config, build } = context
  const rows = []

  // The cold build. `build` was measured once per repository, before any
  // scenario ran, so this row reports it rather than re-measuring it — and
  // emits it only once, because a build does not happen per budget and two
  // identical rows under two budgets would read as two measurements.
  if (budget === BUDGETS[0].limit) {
    rows.push(makeRow({
      ...base,
      scenario: 'index-profile',
      question_id: 'cold-build',
      tool: 'fullBuild',
      budget_limit: null,
      files: build.result.files,
      nodes: build.result.nodes,
      edges: build.result.edges,
      db_bytes: build.dbBytes,
      elapsed_ms: build.elapsedMs,
    }))
  }

  for (const query of WARM_QUERIES) {
    const identity = {
      ...base,
      scenario: 'index-profile',
      question_id: `warm-${query.tool}`,
      tool: query.tool,
      budget_limit: budget,
    }
    try {
      const args = { ...query.args, max_tokens: budget }
      // Once to warm the statement cache, then the samples that count.
      callTool(db, query.tool, args, { config, freshness })
      const samples = []
      let last
      for (let i = 0; i < REPEATS; i += 1) {
        last = callTool(db, query.tool, args, { config, freshness })
        samples.push(last.elapsedMs)
      }
      const counted = counter.count(last.result)
      rows.push(makeRow({
        ...identity,
        graph_tokens: counted.estimated,
        real_tokens: counted.real,
        est_real_ratio: counted.ratio,
        // `code_overview` is the only tool that reports call resolution, and it
        // is a property of the index rather than of this query.
        call_resolution: last.result.totals?.callResolution ?? null,
        elapsed_ms: median(samples),
      }))
    } catch (error) {
      rows.push(errorRow(identity, error))
    }
  }
  return rows
}
