/**
 * Token budgets, and the SQL escaping that keeps a focus from becoming a glob.
 *
 * Every read tool answers into a budget: it drops whole rows rather than
 * truncating one, and says so. `escapeLike` belongs here because the budget is
 * only honest if the rows counted against it are the rows the caller asked for.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { clampBudget, estimateTokens, fitRows } from '../../src/query/budget.ts'
import { findSymbols } from '../../src/query/find.ts'
import { overview } from '../../src/query/overview.ts'
import { escapeLike, pathPrefixLike } from '../../src/query/sql.ts'
import { createFixture } from '../helpers/fixture.mjs'

describe('token budget', () => {
  it('clamps to the supported range', () => {
    assert.equal(clampBudget(undefined), 1500)
    assert.equal(clampBudget(99999), 6000)
    assert.equal(clampBudget(10), 100)
  })

  it('drops whole rows and flags truncation', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i, pad: 'x'.repeat(200) }))
    const fitted = fitRows(rows, 500)
    assert.ok(fitted.truncated)
    assert.ok(fitted.rows.length < rows.length)
    assert.equal(fitted.dropped, rows.length - fitted.rows.length)
    for (const r of fitted.rows) assert.equal(typeof r.i, 'number', 'rows stay well-formed')
  })

  it('keeps at least one row even under a tiny budget', () => {
    const fitted = fitRows([{ pad: 'y'.repeat(10_000) }], 10)
    assert.equal(fitted.rows.length, 1)
  })

  it('estimates tokens for any JSON value', () => {
    assert.equal(estimateTokens(''), 0)
    assert.ok(estimateTokens({ a: 'bbbb' }) > 0)
  })
})

describe('token budget in a read tool', () => {
  // Enough same-prefixed symbols that a 120-token budget has to cut the list.
  const fixture = createFixture('cg-budget-')
  let db

  before(async () => {
    fixture.write(
      'src/many.ts',
      Array.from({ length: 40 }, (_, i) => `export function entry${i}(): number { return ${i} }`).join('\n') + '\n',
    )
    db = await fixture.build()
  })

  after(() => fixture.cleanup())

  it('honors the budget in code_find', () => {
    const r = findSymbols(db, { query: 'e', budget: 120 })
    assert.ok(r.used <= 200, `stayed near budget (used ${r.used})`)
  })
})

describe('LIKE escape', () => {
  it('treats % and _ as literals', () => {
    assert.equal(escapeLike('src_x'), 'src\\_x')
    assert.equal(escapeLike('100%'), '100\\%')
    assert.equal(pathPrefixLike('src_'), 'src\\_/%')
  })

  it('overview focus with _ does not match a one-char sibling', async () => {
    const fx = createFixture('cg-like-')
    try {
      fx.write('src/a.ts', 'export const a = 1\n')
      fx.write('src2/b.ts', 'export const b = 2\n')
      const db = await fx.build()
      const wild = overview(db, 'src_', 1500)
      assert.equal(wild.totals.files, 0, 'src_ is not a SQL wildcard for src2')
      assert.equal(wild.status, 'empty', 'a focus that matches nothing says so')
      const scoped = overview(db, 'src', 1500)
      assert.equal(scoped.totals.files, 1)
    } finally {
      fx.cleanup()
    }
  })
})
