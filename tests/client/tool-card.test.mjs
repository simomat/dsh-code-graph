/**
 * The tool-row projection: what a frozen tool call says about the index.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toolCard } from '../../src/client/tool-card-model.ts'

describe('tool row projection', () => {
  const settled = (meta, extra = {}) => ({
    kind: 'tool-result',
    callId: 'c1',
    call: { name: 'code_find', argsRaw: '{"query":"Service"}' },
    content: [],
    isError: false,
    meta,
    ...extra,
  })

  it('names the subject a person would recognize', () => {
    assert.equal(toolCard(settled({})).subject, 'Service')
    assert.equal(toolCard({ callId: 'c', name: 'code_impact', argsRaw: '{"paths":["a.ts","b.ts"]}', subCalls: [] }).subject,
      'a.ts, b.ts')
    assert.equal(toolCard(settled({}, { call: { name: 'x', argsRaw: 'not json' } })).subject, null)
  })

  it('reads a call still in flight', () => {
    const card = toolCard({ callId: 'c', name: 'code_find', argsRaw: '{"query":"S"}', subCalls: [] })
    assert.equal(card.state, 'running')
    assert.equal(card.index, undefined)
  })

  it('carries index state and freshness off the projection', () => {
    const card = toolCard(settled({ status: 'stale', freshness: { dirtyFiles: 3, builtAt: 1000 } }))
    assert.equal(card.state, 'ok')
    assert.equal(card.index, 'stale')
    assert.deepEqual(card.freshness, { dirtyFiles: 3, builtAt: 1000 })
  })

  it('carries build progress', () => {
    const card = toolCard(settled({ status: 'building', progress: { parsed: 4, total: 9, phase: 'parsing' } }))
    assert.equal(card.index, 'building')
    assert.deepEqual(card.progress, { parsed: 4, total: 9, phase: 'parsing' })
  })

  it('carries the overview totals', () => {
    const card = toolCard(settled({
      status: 'ready',
      totals: { files: 4, symbols: 40, edges: 12, tests: 1 },
      languages: [{ lang: 'typescript', files: 4 }],
    }))
    assert.deepEqual(card.totals, { files: 4, symbols: 40, edges: 12, tests: 1 })
    assert.deepEqual(card.languages, [{ lang: 'typescript', files: 4 }])
  })

  it('says nothing about the index when the call carries no projection', () => {
    assert.equal(toolCard(settled(undefined)).index, undefined)
    assert.equal(toolCard(settled('nonsense')).index, undefined)
    assert.equal(toolCard(settled({ status: 'something-else' })).index, undefined)
  })

  it('distinguishes an interruption from a failure', () => {
    assert.equal(toolCard(settled({}, { isError: true, error: { name: 'E', code: 'interrupted' } })).state, 'stopped')
    assert.equal(toolCard(settled({}, { isError: true, error: { name: 'E', code: 'boom' } })).state, 'error')
  })
})
