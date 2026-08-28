/**
 * Recording the budget confound honestly.
 *
 * `truncated` means "rows are missing", not "the budget bit", and each tool
 * folds a different set of causes into that one boolean. These assertions pin
 * what each result shape can actually support — including the two places where
 * the honest answer is `unknown`, because a bench that reported `none` there
 * would be quietly claiming a complete answer it never got.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { codeFindSpec } from '../../src/tools/specs.ts'
import { errorRow, makeRow, ratio, truncationOf } from '../../bench/rows.mjs'
import { createFixture } from '../helpers/fixture.mjs'

const rows = (n) => Array.from({ length: n }, (_, i) => ({ i }))

describe('code_find truncation', () => {
  it('is none when every match came back', () => {
    const t = truncationOf('code_find', { hits: rows(2), total: 2, truncated: false })
    assert.deepEqual(t, { truncated: false, cause: 'none', returned: 2, total: 2, dropped: 0 })
  })

  it('is cap when the SQL limit bit but the budget did not', () => {
    const t = truncationOf('code_find', { hits: rows(40), total: 50, truncated: false })
    assert.equal(t.cause, 'cap')
    assert.equal(t.dropped, 10)
  })

  it('is both when the limit and the budget each dropped rows', () => {
    const t = truncationOf('code_find', { hits: rows(10), total: 50, truncated: true })
    assert.equal(t.cause, 'both')
    assert.equal(t.dropped, 40)
  })

  it('honours a non-default limit argument', () => {
    const t = truncationOf('code_find', { hits: rows(5), total: 8, truncated: false }, { limit: 200 })
    assert.equal(t.cause, 'none', '8 matches is under a limit of 200, so nothing was capped')
  })
})

describe('code_relations truncation', () => {
  it('is budget when a section came back short of a count below the cap', () => {
    const t = truncationOf('code_relations', {
      counts: { callers: 5 }, relations: { callers: rows(3) }, truncated: true,
    })
    assert.equal(t.cause, 'budget')
    assert.deepEqual([t.returned, t.total, t.dropped], [3, 5, 2])
  })

  it('is cap when a section sits exactly on the per-relation cap', () => {
    const t = truncationOf('code_relations', {
      counts: { callers: 60 }, relations: { callers: rows(30) }, truncated: true,
    })
    assert.equal(t.cause, 'cap')
  })

  it('is both when the cap ran first and the budget cut further', () => {
    const t = truncationOf('code_relations', {
      counts: { callers: 60 }, relations: { callers: rows(12) }, truncated: true,
    })
    assert.equal(t.cause, 'both')
  })

  it('is none when every section is complete', () => {
    const t = truncationOf('code_relations', {
      counts: { callers: 2, callees: 1 }, relations: { callers: rows(2), callees: rows(1) }, truncated: false,
    })
    assert.equal(t.cause, 'none')
    assert.equal(t.dropped, 0)
  })
})

describe('code_overview truncation', () => {
  const result = (over) => ({ modules: rows(3), hubs: rows(2), entryPoints: rows(1), truncated: false, ...over })

  it('is none when nothing is at a cap and the flag is clear', () => {
    assert.equal(truncationOf('code_overview', result()).cause, 'none')
  })

  it('is budget when the flag is set and no section sits on a cap', () => {
    assert.equal(truncationOf('code_overview', result({ truncated: true })).cause, 'budget')
  })

  it('is unknown when a section sits on a SQL cap the result never reports', () => {
    assert.equal(truncationOf('code_overview', result({ hubs: rows(15) })).cause, 'unknown')
    assert.equal(truncationOf('code_overview', result({ hubs: rows(15), truncated: true })).cause, 'unknown')
  })

  it('leaves the totals empty rather than guessing them', () => {
    const t = truncationOf('code_overview', result())
    assert.equal(t.total, null)
    assert.equal(t.dropped, null)
  })
})

describe('code_impact truncation', () => {
  it('is none when the whole BFS result fitted', () => {
    const t = truncationOf('code_impact', { affected: rows(5), totalAffected: 5, truncated: false })
    assert.equal(t.cause, 'none')
  })

  it('is budget when rows were dropped after the BFS produced them', () => {
    const t = truncationOf('code_impact', { affected: rows(5), totalAffected: 20, truncated: true })
    assert.equal(t.cause, 'budget')
    assert.equal(t.dropped, 15)
  })

  it('is cap when rows are missing but the budget dropped none', () => {
    const t = truncationOf('code_impact', { affected: rows(5), totalAffected: 5, truncated: true })
    assert.equal(t.cause, 'cap')
    assert.equal(t.dropped, 0)
  })
})

describe('unknown tools', () => {
  it('throws rather than inventing a shape', () => {
    assert.throws(() => truncationOf('code_summarise', {}), /unknown tool/)
  })
})

describe('truncation against a real result', () => {
  // Enough same-prefixed symbols that a small budget must cut the list, so the
  // derivation above is checked against what the tool actually returns.
  const fixture = createFixture('cg-bench-rows-')
  let db

  before(async () => {
    fixture.write(
      'src/many.ts',
      Array.from({ length: 60 }, (_, i) => `export function entry${i}(): number { return ${i} }`).join('\n') + '\n',
    )
    db = await fixture.build()
  })

  after(() => fixture.cleanup())

  it('reads a budget-truncated code_find the way the synthetic cases predict', () => {
    const result = codeFindSpec.run(db, { query: 'entry', limit: 40 }, 200)
    const t = truncationOf('code_find', result, { limit: 40 })
    assert.ok(t.truncated, 'a 200-token budget cannot hold 40 hits')
    assert.ok(t.returned < t.total, 'the caller saw fewer rows than matched')
    assert.equal(t.dropped, t.total - t.returned)
    assert.ok(['budget', 'both'].includes(t.cause), `budget is implicated (got ${t.cause})`)
  })

  it('reads a complete code_find as none', () => {
    const result = codeFindSpec.run(db, { query: 'entry7', limit: 40 }, 6000)
    const t = truncationOf('code_find', result, { limit: 40 })
    assert.equal(t.cause, 'none')
    assert.equal(t.dropped, 0)
  })
})

describe('row construction', () => {
  it('defaults to a measured, estimated row', () => {
    const row = makeRow({ tool: 'code_find' })
    assert.equal(row.status, 'ok')
    assert.equal(row.estimated, true)
  })

  it('gives a thrown call no token columns at all', () => {
    const row = errorRow({ tool: 'code_find', repo: 'express' }, new Error('no such symbol'))
    assert.equal(row.status, 'error')
    assert.equal(row.error, 'no such symbol')
    for (const column of ['baseline_tokens', 'graph_tokens', 'ratio', 'truncated', 'real_tokens']) {
      assert.equal(row[column], null, `${column} is absent, not zero`)
    }
  })
})

describe('ratio', () => {
  it('is absent rather than infinite when the graph cost nothing', () => {
    assert.equal(ratio(1000, 0), null, 'a zero denominator is how a failure becomes a win')
    assert.equal(ratio(1000, null), null)
  })

  it('rounds to two places', () => {
    assert.equal(ratio(1000, 300), 3.33)
  })
})
