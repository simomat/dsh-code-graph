/**
 * A thrown tool call is not a measurement.
 *
 * The reference project this harness borrows its methodology from shipped two
 * bugs of exactly this shape: a thrown call that produced `graph_tokens = 0` and
 * so a ratio of `baseline / 1`, and one that silently set its prediction equal
 * to the ground truth and so scored a perfect recall. Both made a failure look
 * like a win. These assertions are the regression test for that class.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toCsv } from '../../bench/csv.mjs'
import { errorRow, makeRow } from '../../bench/rows.mjs'
import { markdownTable, median, okRows, summarise } from '../../bench/report.mjs'

const measured = (over) => makeRow({
  scenario: 'agent-baseline',
  repo: 'express',
  budget_limit: 1500,
  baseline_tokens: 8000,
  graph_tokens: 400,
  ratio: 20,
  truncated: false,
  ...over,
})

const failed = (over) => errorRow({
  scenario: 'agent-baseline',
  repo: 'express',
  budget_limit: 1500,
  question_id: 'q-boom',
  ...over,
}, new Error('boom'))

describe('error rows', () => {
  it('stay in the CSV for forensics', () => {
    const csv = toCsv([measured(), failed()])
    assert.match(csv, /boom/, 'the message survives to disk')
    assert.equal(csv.trimEnd().split('\n').length, 3, 'header plus both rows')
  })

  it('are excluded from every aggregate', () => {
    const all = [measured(), measured(), failed(), failed()]
    assert.equal(okRows(all).length, 2)

    const [summary] = summarise(all)
    assert.equal(summary.calls, 2, 'only measured calls are counted')
    assert.equal(summary.errors, 2, 'but the failures are still reported')
    assert.equal(summary.ratio, 20, 'the failures did not move the ratio')
  })

  it('never contribute a zero that inflates a ratio', () => {
    // The exact historical bug: a thrown call recorded as graph_tokens = 0.
    const all = [measured(), failed()]
    const graphValues = okRows(all).map((r) => r.graph_tokens)
    assert.ok(graphValues.every((v) => v > 0), 'no zero reached the aggregate')
    assert.equal(summarise(all)[0].graph, 400)
  })

  it('leave an all-error group with no summary rather than a fabricated one', () => {
    assert.deepEqual(summarise([failed(), failed()]), [])
  })
})

describe('grouping', () => {
  it('separates budgets, because a ratio without its budget is meaningless', () => {
    const summaries = summarise([
      measured({ budget_limit: 1500, graph_tokens: 400, ratio: 20 }),
      measured({ budget_limit: 6000, graph_tokens: 1600, ratio: 5 }),
    ])
    assert.equal(summaries.length, 2, 'the two budgets are never averaged together')
    assert.deepEqual(summaries.map((s) => s.budget), [1500, 6000])
    assert.deepEqual(summaries.map((s) => s.ratio), [20, 5])
  })

  it('reports the share of results that hit the budget', () => {
    const [summary] = summarise([
      measured({ truncated: true }),
      measured({ truncated: true }),
      measured({ truncated: false }),
      measured({ truncated: false }),
    ])
    assert.equal(summary.truncated, 2)
    assert.equal(summary.truncatedShare, 50)
  })
})

describe('median', () => {
  it('takes the middle of an odd list and the mean of the middle two of an even one', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([1, 2, 3, 4]), 2.5)
  })

  it('is absent for an empty list, and ignores non-numbers', () => {
    assert.equal(median([]), null)
    assert.equal(median([null, undefined, 4]), 4)
  })
})

describe('markdown table', () => {
  it('renders an absent value as a dash rather than as empty or zero', () => {
    const table = markdownTable(['a', 'b'], [[1, null]])
    assert.match(table, /\| 1 \| — \|/)
  })
})
