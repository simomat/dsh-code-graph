/**
 * Scenario A — the whole indexed corpus against the graph answer.
 *
 * **This is an upper bound, and it is labelled as one everywhere it appears.**
 * The baseline is every file the index covers, which is what an agent would pay
 * only if it read the entire repository to answer one question. No real agent
 * does that, so the ratio this produces is a ceiling, not a claim.
 *
 * It is kept because it answers a question the honest baseline cannot: how much
 * of a repository the graph is standing in for. The reference project quotes
 * exactly this number as its headline, which is the part of its methodology
 * worth *not* copying.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callTool, indexedFiles } from '../graph.mjs'
import { errorRow, makeRow, ratio, truncationOf } from '../rows.mjs'
import { QUESTIONS } from '../questions.mjs'

/** How this scenario's baseline is described in every row it writes. */
const BASELINE_KIND = 'corpus-upper-bound'

/**
 * Sum the tokens of every file the index covers.
 *
 * Read from disk rather than derived from the stored `size`, because `size` is
 * bytes and the estimate is over characters — for any non-ASCII source the two
 * disagree, always in the direction that inflates the baseline.
 * @param db - the open graph.
 * @param repoDir - the checked-out repository.
 * @param counter - the token counter.
 * @returns `{ tokens, real, files }`.
 */
export function corpusTokens(db, repoDir, counter) {
  let tokens = 0
  let real = 0
  let files = 0
  for (const file of indexedFiles(db)) {
    let text
    try {
      text = readFileSync(join(repoDir, file.path), 'utf8')
    } catch {
      continue
    }
    const counted = counter.count(text)
    tokens += counted.estimated
    if (counted.real !== null) real += counted.real
    files += 1
  }
  return { tokens, real: counter.verify ? real : null, files }
}

/**
 * Run the scenario for one repository at one budget.
 * @param context - the shared per-repo run context.
 * @returns Rows, errors included.
 */
export function run(context) {
  const { db, repo, budget, counter, base, freshness, config } = context
  const corpus = corpusTokens(db, repo.dir, counter)
  const rows = []

  for (const question of QUESTIONS[repo.name] ?? []) {
    const identity = {
      ...base,
      scenario: 'corpus-baseline',
      question_id: question.id,
      tool: question.tool,
      budget_limit: budget,
    }
    try {
      const args = { ...question.args, max_tokens: budget }
      const { result, elapsedMs } = callTool(db, question.tool, args, { config, freshness })
      const counted = counter.count(result)
      const truncation = truncationOf(question.tool, result, args)
      rows.push(makeRow({
        ...identity,
        baseline_kind: BASELINE_KIND,
        baseline_tokens: corpus.tokens,
        graph_tokens: counted.estimated,
        ratio: ratio(corpus.tokens, counted.estimated),
        truncated: truncation.truncated,
        truncation_cause: truncation.cause,
        returned_rows: truncation.returned,
        total_rows: truncation.total,
        dropped_rows: truncation.dropped,
        real_tokens: counted.real,
        est_real_ratio: counted.ratio,
        files: corpus.files,
        elapsed_ms: elapsedMs,
      }))
    } catch (error) {
      rows.push(errorRow({ ...identity, baseline_kind: BASELINE_KIND, files: corpus.files }, error))
    }
  }
  return rows
}
