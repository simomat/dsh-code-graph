/**
 * The tool layer: argument guards, and the spec set itself.
 *
 * Every tool entry point rejects the arguments it cannot act on before any
 * query runs, so a caller gets the reason rather than an empty result.
 *
 * The specs are asserted here because they are no longer only a registration
 * detail — the benchmark harness reads them to measure what every session pays
 * for the tool definitions, so a spec silently dropped from the array would
 * show up as a token saving rather than as a missing tool.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TOOL_NAMES } from '../src/config.ts'
import { requireNonEmpty, requirePaths } from '../src/tools/args.ts'
import { graphToolSpecs } from '../src/tools/specs.ts'

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

describe('tool specs', () => {
  it('covers every declared tool name, in order', () => {
    assert.deepEqual(graphToolSpecs.map((s) => s.name), [...TOOL_NAMES])
  })

  it('gives every spec the parts a registration needs', () => {
    for (const spec of graphToolSpecs) {
      assert.ok(spec.description.length > 0, `${spec.name} has a description`)
      assert.equal(typeof spec.run, 'function', `${spec.name} has a run`)
      assert.equal(typeof spec.title, 'function', `${spec.name} has a title`)
      assert.ok(spec.parameters.max_tokens, `${spec.name} accepts a budget`)
    }
  })
})
