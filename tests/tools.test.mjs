/**
 * Tool-layer argument guards.
 *
 * Every tool entry point rejects the arguments it cannot act on before any
 * query runs, so a caller gets the reason rather than an empty result.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { requireNonEmpty, requirePaths } from '../src/tools/args.ts'

describe('tool argument guards', () => {
  it('rejects empty query and symbol', () => {
    assert.throws(() => requireNonEmpty('query', ''), /query must not be empty/)
    assert.throws(() => requireNonEmpty('query', '   '), /query must not be empty/)
    assert.throws(() => requireNonEmpty('symbol', ''), /symbol must not be empty/)
    assert.equal(requireNonEmpty('query', 'helper'), 'helper')
  })

  it('rejects empty paths', () => {
    assert.throws(() => requirePaths(undefined), /paths must not be empty/)
    assert.throws(() => requirePaths([]), /paths must not be empty/)
    assert.deepEqual(requirePaths(['src/a.ts']), ['src/a.ts'])
  })
})
