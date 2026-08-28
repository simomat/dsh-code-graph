/**
 * Turning a tool result into a row, without flattering it.
 *
 * Two things this file exists to get right.
 *
 * **The budget confound.** Every result is capped by `defaultBudget` (1500) and
 * `maxBudget` (6000). A reduction ratio quoted without the budget beside it is
 * close to meaningless, because `graph_tokens` is then bounded by configuration
 * rather than by what the graph found. So every row carries the budget in force
 * and whether the result hit it.
 *
 * **`truncated` conflates causes.** The flag means "rows are missing", not "the
 * budget bit". Each tool merges a different set of causes into it, and two of
 * them cannot separate those causes at all. `truncationOf` reports what each
 * result can actually support and says `unknown` where it cannot — see the
 * per-tool notes below. Recording `none` there would be a lie of omission.
 */

/** Section cap `getRelations` applies before the budget is consulted. */
const MAX_PER_RELATION = 30

/** Pre-caps `overview` applies in SQL, none of which reach its `truncated` flag. */
const OVERVIEW_CAPS = { modules: 40, hubs: 15, entryPoints: 12 }

/**
 * Merge two truncation causes.
 * @param a - one cause.
 * @param b - the other.
 * @returns The combined cause.
 */
function mergeCause(a, b) {
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  if (a === 'none') return b
  if (b === 'none') return a
  return a === b ? a : 'both'
}

/**
 * What a `code_find` result can say about its missing rows.
 *
 * `total` is the true match count before the SQL `limit` and before the budget,
 * so `total - hits.length` is real but mixed. The flag isolates the budget; a
 * `total` above the limit isolates the cap.
 * @param result - the tool-shaped result.
 * @param limit - the `limit` argument in force (default 40).
 * @returns Truncation bookkeeping.
 */
function findTruncation(result, limit = 40) {
  const returned = result.hits.length
  const total = result.total
  const budget = result.truncated ? 'budget' : 'none'
  const cap = total > limit ? 'cap' : 'none'
  return {
    truncated: result.truncated,
    cause: mergeCause(budget, cap),
    returned,
    total,
    dropped: total - returned,
  }
}

/**
 * What a `code_relations` result can say about its missing rows.
 *
 * `counts` holds the true per-section totals, so this one is fully separable:
 * a section that came back at exactly the cap with more to give was capped, and
 * a section short of both the cap and its count was cut by the budget.
 * @param result - the tool-shaped result.
 * @returns Truncation bookkeeping.
 */
function relationsTruncation(result) {
  let returned = 0
  let total = 0
  let cause = 'none'
  for (const [key, count] of Object.entries(result.counts ?? {})) {
    const rows = result.relations?.[key] ?? []
    returned += rows.length
    total += count
    if (rows.length >= count) continue
    // The SQL cap drops rows before the budget ever sees them, so a section
    // sitting exactly on the cap was capped; anything below it was also budgeted.
    if (rows.length === MAX_PER_RELATION) cause = mergeCause(cause, 'cap')
    else cause = mergeCause(cause, count > MAX_PER_RELATION ? 'both' : 'budget')
  }
  return { truncated: result.truncated, cause, returned, total, dropped: total - returned }
}

/**
 * What a `code_overview` result can say about its missing rows — which is little.
 *
 * The flag covers only the budget fit over `modules` and `hubs`. The SQL
 * pre-caps are invisible to it and the result reports no total, so a section
 * sitting exactly on its cap may or may not have lost rows and nothing in the
 * response can settle it. That is `unknown`, and `total`/`dropped` stay empty
 * rather than being guessed at.
 * @param result - the tool-shaped result.
 * @returns Truncation bookkeeping.
 */
function overviewTruncation(result) {
  const modules = result.modules?.length ?? 0
  const hubs = result.hubs?.length ?? 0
  const entryPoints = result.entryPoints?.length ?? 0
  const atCap = modules >= OVERVIEW_CAPS.modules
    || hubs >= OVERVIEW_CAPS.hubs
    || entryPoints >= OVERVIEW_CAPS.entryPoints
  const cause = result.truncated
    ? mergeCause('budget', atCap ? 'unknown' : 'none')
    : (atCap ? 'unknown' : 'none')
  return {
    truncated: result.truncated,
    cause,
    returned: modules + hubs + entryPoints,
    total: null,
    dropped: null,
  }
}

/**
 * What a `code_impact` result can say about its missing rows.
 *
 * `totalAffected` is the BFS output count, taken before the budget fit, so the
 * difference is exactly what the budget dropped. The flag additionally folds in
 * the per-layer BFS cap, which the result never reports separately — so a
 * `budget` cause here does not rule out the cap having fired too. Only the
 * reverse is provable: rows missing with nothing budget-dropped means the cap.
 * @param result - the tool-shaped result.
 * @returns Truncation bookkeeping.
 */
function impactTruncation(result) {
  const returned = result.affected?.length ?? 0
  const total = result.totalAffected ?? returned
  const dropped = total - returned
  let cause = 'none'
  if (result.truncated) cause = dropped > 0 ? 'budget' : 'cap'
  return { truncated: result.truncated, cause, returned, total, dropped }
}

/**
 * Truncation bookkeeping for any tool result.
 * @param tool - the tool's wire name.
 * @param result - the tool-shaped result.
 * @param args - the arguments the call ran with, for the `code_find` limit.
 * @returns `{ truncated, cause, returned, total, dropped }`.
 */
export function truncationOf(tool, result, args = {}) {
  switch (tool) {
    case 'code_find': return findTruncation(result, args.limit ?? 40)
    case 'code_relations': return relationsTruncation(result)
    case 'code_overview': return overviewTruncation(result)
    case 'code_impact': return impactTruncation(result)
    default: throw new Error(`unknown tool: ${tool}`)
  }
}

/**
 * A row with every column present, so the CSV stays rectangular.
 * @param fields - the columns this row actually fills.
 * @returns A row object.
 */
export function makeRow(fields) {
  return { status: 'ok', estimated: true, ...fields }
}

/**
 * The row a thrown tool call produces.
 *
 * Kept in the CSV for forensics and excluded from every aggregate. It carries
 * **no** token columns: a thrown call measured nothing, and a `graph_tokens` of
 * 0 here is what previously turned failures into apparent wins.
 * @param fields - identifying columns for the call that failed.
 * @param error - the thrown value.
 * @returns A row object with `status: 'error'`.
 */
export function errorRow(fields, error) {
  return {
    ...fields,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    baseline_tokens: null,
    graph_tokens: null,
    ratio: null,
    truncated: null,
    truncation_cause: null,
    returned_rows: null,
    total_rows: null,
    dropped_rows: null,
    real_tokens: null,
    est_real_ratio: null,
  }
}

/**
 * The reduction ratio, guarded.
 *
 * A zero denominator is not a win of infinite size; it is a row with nothing to
 * compare, and it comes back null so no aggregate can absorb it.
 * @param baseline - the baseline token count.
 * @param graph - the graph token count.
 * @returns Baseline-to-graph ratio to two places, or null.
 */
export function ratio(baseline, graph) {
  if (!Number.isFinite(baseline) || !Number.isFinite(graph) || graph <= 0) return null
  return Math.round((baseline / graph) * 100) / 100
}
