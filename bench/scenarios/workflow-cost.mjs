/**
 * Scenario C — absolute cost, no baseline.
 *
 * Some questions are not "is this cheaper than grep". A session has a context
 * window, and what a maintainer actually needs to know is what a realistic piece
 * of work costs end to end. So this scenario runs a fixed sequence of calls and
 * reports the total, with no ratio at all — inventing a baseline here would only
 * dress up an absolute number as a comparison.
 *
 * Each step is also written out as its own row. A four-call workflow whose cost
 * is 90% one `code_impact` is a different thing from one that spreads evenly,
 * and a total alone hides which.
 */
import { callTool } from '../graph.mjs'
import { errorRow, makeRow, truncationOf } from '../rows.mjs'
import { ratioOf } from '../tokens.mjs'
import { WORKFLOWS } from '../questions.mjs'

/**
 * Run the scenario for one repository at one budget.
 * @param context - the shared per-repo run context.
 * @returns Rows, errors included.
 */
export function run(context) {
  const { db, repo, budget, counter, base, freshness, config } = context
  const rows = []

  for (const workflow of WORKFLOWS[repo.name] ?? []) {
    let total = 0
    let realTotal = 0
    let elapsed = 0
    let failed = false

    for (const [index, step] of workflow.steps.entries()) {
      const identity = {
        ...base,
        scenario: 'workflow-cost',
        // The step index keeps a workflow's rows ordered and lets a reader see
        // which call in the sequence the cost actually sat in.
        question_id: `${workflow.id}#${index + 1}-${step.tool}`,
        tool: step.tool,
        budget_limit: budget,
      }
      try {
        const args = { ...step.args, max_tokens: budget }
        const { result, elapsedMs } = callTool(db, step.tool, args, { config, freshness })
        const counted = counter.count(result)
        const truncation = truncationOf(step.tool, result, args)
        total += counted.estimated
        if (counted.real !== null) realTotal += counted.real
        elapsed += elapsedMs
        rows.push(makeRow({
          ...identity,
          graph_tokens: counted.estimated,
          truncated: truncation.truncated,
          truncation_cause: truncation.cause,
          returned_rows: truncation.returned,
          total_rows: truncation.total,
          dropped_rows: truncation.dropped,
          real_tokens: counted.real,
          est_real_ratio: counted.ratio,
          elapsed_ms: elapsedMs,
        }))
      } catch (error) {
        // A workflow with a failed step has no honest total: the missing call
        // would have cost something. The step is recorded and the total is
        // suppressed rather than reported as the sum of what happened to work.
        failed = true
        rows.push(errorRow(identity, error))
      }
    }

    if (!failed) {
      rows.push(makeRow({
        ...base,
        scenario: 'workflow-cost',
        question_id: `${workflow.id}#total`,
        tool: 'workflow',
        budget_limit: budget,
        graph_tokens: total,
        real_tokens: counter.verify ? realTotal : null,
        est_real_ratio: counter.verify ? ratioOf(total, realTotal) : null,
        returned_rows: workflow.steps.length,
        elapsed_ms: elapsed,
      }))
    }
  }
  return rows
}
