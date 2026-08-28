/**
 * Scenario B — the honest number.
 *
 * This is the comparison the plugin's pitch actually rests on: an agent without
 * a graph greps the repository for the terms in the question, ranks the files by
 * how often they match, reads the top three in full, and pays for all of it.
 * An agent with a graph makes one structured call.
 *
 * The baseline is deliberately given every advantage that is cheap to give it.
 * It only ever reads three files, not ten. It greps only the files the index
 * covers, so it is never charged for a lockfile the graph also ignores. And the
 * search terms drop question-framing verbs, which models an agent that greps for
 * the identifier rather than for the sentence — see `bench/config.mjs`.
 *
 * The ratio still has to be read next to `budget_limit` and `truncated`. A graph
 * answer that hit its budget is cheap partly because it was cut off, and a row
 * that does not say so is not a measurement anyone can use.
 */
import { grepAndRead, deriveTerms } from '../grep.mjs'
import { callTool, indexedFiles } from '../graph.mjs'
import { errorRow, makeRow, ratio, truncationOf } from '../rows.mjs'
import { QUESTIONS } from '../questions.mjs'

/** How this scenario's baseline is described in every row it writes. */
const BASELINE_KIND = 'agent-grep-read-top3'

/** How many files the simulated agent reads after grepping. */
const TOP_N = 3

/**
 * What the grep-and-read loop costs for one question.
 * @param files - the indexed file list.
 * @param question - the question, possibly carrying a `terms` override.
 * @param repoDir - the checked-out repository.
 * @param counter - the token counter.
 * @returns `{ tokens, real, read, candidates, terms }`.
 */
export function baselineFor(files, question, repoDir, counter) {
  const terms = question.terms ?? deriveTerms(question.text)
  const { read, candidates } = grepAndRead(files, terms, { repoDir, topN: TOP_N })
  let tokens = 0
  let real = 0
  for (const hit of read) {
    // The whole file, because that is what a `read` tool call costs — an agent
    // does not get to pay for only the matching line.
    const counted = counter.count(hit.text)
    tokens += counted.estimated
    if (counted.real !== null) real += counted.real
  }
  return { tokens, real: counter.verify ? real : null, read, candidates, terms }
}

/**
 * Run the scenario for one repository at one budget.
 * @param context - the shared per-repo run context.
 * @returns Rows, errors included.
 */
export function run(context) {
  const { db, repo, budget, counter, base, freshness, config } = context
  const files = indexedFiles(db)
  const rows = []

  for (const question of QUESTIONS[repo.name] ?? []) {
    const identity = {
      ...base,
      scenario: 'agent-baseline',
      question_id: question.id,
      tool: question.tool,
      budget_limit: budget,
      baseline_kind: BASELINE_KIND,
    }
    try {
      const baseline = baselineFor(files, question, repo.dir, counter)
      const args = { ...question.args, max_tokens: budget }
      const { result, elapsedMs } = callTool(db, question.tool, args, { config, freshness })
      const counted = counter.count(result)
      const truncation = truncationOf(question.tool, result, args)
      rows.push(makeRow({
        ...identity,
        baseline_tokens: baseline.tokens,
        graph_tokens: counted.estimated,
        ratio: ratio(baseline.tokens, counted.estimated),
        truncated: truncation.truncated,
        truncation_cause: truncation.cause,
        returned_rows: truncation.returned,
        total_rows: truncation.total,
        dropped_rows: truncation.dropped,
        real_tokens: counted.real,
        est_real_ratio: counted.ratio,
        // How many files the grep surfaced, so a baseline built on one candidate
        // is distinguishable from one built on hundreds.
        files: baseline.candidates,
        elapsed_ms: elapsedMs,
      }))
    } catch (error) {
      rows.push(errorRow(identity, error))
    }
  }
  return rows
}
