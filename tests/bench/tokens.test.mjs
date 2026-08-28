/**
 * The benchmark's token counter.
 *
 * The estimate has to match `src/query/budget.ts` exactly. If the two ever
 * diverge, every truncation row in the CSV becomes unreadable: the measurement
 * would be on one scale and the budget that shaped it on another.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { estimateTokens as budgetEstimate } from '../../src/query/budget.ts'
import { charsOf, createCounter, estimateTokens, ratioOf } from '../../bench/tokens.mjs'

describe('token estimate', () => {
  it('counts characters of strings and of serialised values', () => {
    assert.equal(charsOf('abcd'), 4)
    assert.equal(charsOf(undefined), 0)
    assert.equal(charsOf({ a: 1 }), '{"a":1}'.length)
  })

  it('is chars/4, rounded up', () => {
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens('abcd'), 1)
    assert.equal(estimateTokens('abcde'), 2)
  })

  it('agrees with the budgeter it is measuring against', () => {
    for (const value of ['', 'x', 'abcd', 'a'.repeat(999), { a: 'bbbb' }, [1, 2, 3]]) {
      assert.equal(estimateTokens(value), budgetEstimate(value), `same scale for ${JSON.stringify(value)}`)
    }
  })
})

describe('estimate-to-real ratio', () => {
  it('is absent rather than infinite when there was nothing to tokenize', () => {
    assert.equal(ratioOf(5, 0), null)
    assert.equal(ratioOf(5, Number.NaN), null)
  })

  it('rounds to three places', () => {
    assert.equal(ratioOf(1, 3), 0.333)
  })
})

describe('counter', () => {
  it('reports no real count unless verifying', async () => {
    const counter = await createCounter()
    const r = counter.count('hello world')
    assert.equal(r.estimated, 3)
    assert.equal(r.real, null)
    assert.equal(r.ratio, null)
  })

  it('reports both counts and their ratio when verifying', async () => {
    const counter = await createCounter({ verify: true })
    const r = counter.count('function findSymbols(db, opts) { return db.query(opts) }')
    assert.ok(r.real > 0, 'a real tokenizer ran')
    assert.equal(r.ratio, ratioOf(r.estimated, r.real))
  })

  it('counts an empty value as zero on both scales', async () => {
    const counter = await createCounter({ verify: true })
    assert.deepEqual(counter.count(''), { estimated: 0, real: 0, ratio: null })
  })
})
