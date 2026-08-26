/**
 * A name that matches two symbols is not the same answer as a name that
 * matches none, and every tool that takes a symbol has to say which it got.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { getRelations } from '../../src/query/relations.ts'
import { computeImpact } from '../../src/query/impact.ts'
import { resolveSymbol } from '../../src/query/resolve.ts'
import { createFixture } from '../helpers/fixture.mjs'

// ---------------------------------------------------------------------------
// ambiguous is not the same answer as not-found
// ---------------------------------------------------------------------------

describe('ambiguous symbols report their candidates', () => {
  const amb = createFixture('cg-m21-')
  let ambDb

  before(async () => {
    const put = amb.write
    // Two unrelated `format` functions, plus one uniquely named symbol.
    put('src/a.ts', 'export function format(s: string): string { return s }\n')
    put('src/b.ts', 'export function format(n: number): string { return String(n) }\n')
    put('src/only.ts', 'export function onlyOne(): number { return 1 }\n')
    put('src/use.ts', `
import { format } from './a'
export function use(): string { return format('x') }
`)
    ambDb = await amb.build()
  })

  after(() => amb.cleanup())

  it('resolveSymbol separates resolved, ambiguous, and not-found', () => {
    assert.deepEqual(resolveSymbol(ambDb, 'onlyOne'), {
      status: 'resolved', qname: 'src/only.ts::onlyOne',
    })
    assert.deepEqual(resolveSymbol(ambDb, 'format'), {
      status: 'ambiguous', candidates: ['src/a.ts::format', 'src/b.ts::format'],
    })
    assert.deepEqual(resolveSymbol(ambDb, 'noSuchThing'), { status: 'not-found' })
  })

  it('code_relations returns the candidates instead of a bare miss', () => {
    const r = getRelations(ambDb, 'format', 3000)
    assert.equal(r.found, false, 'still not a single symbol')
    assert.deepEqual(r.candidates, ['src/a.ts::format', 'src/b.ts::format'])
  })

  it('a candidate qname answers the follow-up call', () => {
    const r = getRelations(ambDb, 'src/a.ts::format', 3000)
    assert.ok(r.found)
    assert.deepEqual(r.candidates, [], 'a resolved symbol carries no candidates')
    assert.ok(r.relations.callers.some((e) => e.src === 'src/use.ts::use'), 'callers came back')
  })

  it('an unknown symbol carries no candidates', () => {
    const r = getRelations(ambDb, 'noSuchThing', 3000)
    assert.equal(r.found, false)
    assert.deepEqual(r.candidates, [])
  })

  it('code_impact separates ambiguous targets from missing ones', () => {
    const r = computeImpact(ambDb, ['format', 'noSuchThing'], 3, 3000)
    assert.deepEqual(r.unresolved, ['noSuchThing'], 'only the absent target is unresolved')
    assert.deepEqual(r.ambiguous, [
      { query: 'format', candidates: ['src/a.ts::format', 'src/b.ts::format'] },
    ])
  })

  it('an ambiguous target does not suppress the resolvable ones', () => {
    const r = computeImpact(ambDb, ['format', 'src/only.ts::onlyOne'], 3, 3000)
    assert.ok(r.affected.some((n) => n.qname === 'src/only.ts::onlyOne'), 'the clear target ran')
    assert.equal(r.ambiguous.length, 1)
    assert.deepEqual(r.unresolved, [])
  })
})
