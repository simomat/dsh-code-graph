/**
 * The shared CSV writer.
 *
 * Every scenario writes into one schema, so the escaping and the "empty means
 * not applicable" rule are asserted once here rather than trusted five times.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { COLUMNS, formatCell, toCsv } from '../../bench/csv.mjs'

describe('cell formatting', () => {
  it('leaves plain values alone', () => {
    assert.equal(formatCell('code_find'), 'code_find')
    assert.equal(formatCell(42), '42')
    assert.equal(formatCell(true), 'true')
    assert.equal(formatCell(false), 'false')
  })

  it('writes an absent value as empty, never as "null"', () => {
    assert.equal(formatCell(null), '')
    assert.equal(formatCell(undefined), '')
  })

  it('quotes and escapes commas, quotes and newlines', () => {
    assert.equal(formatCell('a,b'), '"a,b"')
    assert.equal(formatCell('say "hi"'), '"say ""hi"""')
    assert.equal(formatCell('line1\nline2'), '"line1\nline2"')
  })
})

describe('document', () => {
  it('emits the header and keeps rows rectangular', () => {
    const csv = toCsv([{ scenario: 'agent-baseline', repo: 'express' }])
    const lines = csv.trimEnd().split('\n')
    assert.equal(lines[0], COLUMNS.join(','))
    assert.equal(lines[1].split(',').length, COLUMNS.length, 'a sparse row still fills every column')
  })

  it('places values under their own headers', () => {
    const csv = toCsv([{ tool: 'code_find', budget_limit: 1500 }])
    const [header, row] = csv.trimEnd().split('\n')
    const at = (name) => row.split(',')[header.split(',').indexOf(name)]
    assert.equal(at('tool'), 'code_find')
    assert.equal(at('budget_limit'), '1500')
    assert.equal(at('ratio'), '')
  })
})
