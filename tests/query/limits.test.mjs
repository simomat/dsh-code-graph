/**
 * The traversal tools at the scale where their own limits bite.
 *
 * Two different ceilings: the per-relation cap that drops rows out of an
 * answer, and SQLite's 32 766-parameter limit, which forces both the frontier
 * and the visited set to be queried in chunks.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { getRelations } from '../../src/query/relations.ts'
import { computeImpact } from '../../src/query/impact.ts'
import { createFixture } from '../helpers/fixture.mjs'

// ---------------------------------------------------------------------------
// M3 / M4 — a fixture wide enough to hit MAX_PER_RELATION (30 callers).
// ---------------------------------------------------------------------------

describe('wide fan-in', () => {
  const CALLERS = 60
  const wide = createFixture('cg-wide-')
  let wideDb

  before(async () => {
    wide.write('src/util.ts', 'export function helper(x: number): number { return x * 2 }\n')
    for (let i = 1; i <= CALLERS; i += 1) {
      wide.write(
        `src/c${i}.ts`,
        `import { helper } from './util'\nexport function c${i}(): number { return helper(${i}) }\n`,
      )
    }
    wideDb = await wide.build()
  })

  after(() => wide.cleanup())

  it('has all callers in the graph', () => {
    const n = wideDb.db
      .prepare("SELECT COUNT(*) AS n FROM edges WHERE dst = ? AND kind = 'CALLS'")
      .get('src/util.ts::helper').n
    assert.equal(n, CALLERS, 'fixture really produces 60 caller edges')
  })

  it('reports the true count when the per-relation cap drops rows', () => {
    const r = getRelations(wideDb, 'src/util.ts::helper', 6000)
    assert.equal(r.counts.callers, CALLERS, 'counts carry the untruncated total')
    assert.ok(r.relations.callers.length < CALLERS, 'the cap really bit')
    assert.equal(r.truncated, true, 'a capped section must not claim completeness')
  })

  it('does not flag truncation for sections that fit', () => {
    const r = getRelations(wideDb, 'src/c1.ts::c1', 6000)
    assert.equal(r.truncated, false, 'nothing was dropped')
    for (const [key, rows] of Object.entries(r.relations)) {
      assert.equal(rows.length, r.counts[key], `${key}: returned matches count`)
    }
  })

  it('flags truncation when the budget alone cuts a section', () => {
    const r = getRelations(wideDb, 'src/util.ts::helper', 300)
    assert.ok(r.relations.callers.length < r.counts.callers)
    assert.equal(r.truncated, true)
  })

  it('reports zeroed counts for an unknown symbol', () => {
    const r = getRelations(wideDb, 'nonexistent_symbol_xyz', 2000)
    assert.equal(r.found, false)
    assert.deepEqual(Object.values(r.counts), Array(10).fill(0))
    assert.equal(r.truncated, false)
  })

  it('reaches callers of a file\'s symbols when the target is the file', () => {
    const bySymbol = computeImpact(wideDb, ['src/util.ts::helper'], 3, 100000)
    const byFile = computeImpact(wideDb, ['src/util.ts'], 3, 100000)

    assert.ok(
      byFile.totalAffected >= bySymbol.totalAffected,
      `file target (${byFile.totalAffected}) must not under-report the symbol `
      + `target (${bySymbol.totalAffected})`,
    )

    const names = new Set(byFile.affected.map((n) => n.name))
    assert.ok(names.has('c1') && names.has(`c${CALLERS}`), 'calling functions are reached')
    assert.ok(names.has('helper'), 'the file\'s own symbols are included')
  })

  it('seeds a targeted file\'s symbols at depth 0', () => {
    const byFile = computeImpact(wideDb, ['src/util.ts'], 3, 100000)
    const helper = byFile.affected.find((n) => n.qname === 'src/util.ts::helper')
    assert.ok(helper, 'helper is seeded')
    assert.equal(helper.depth, 0)
    assert.equal(helper.relation, 'target-member', 'distinguishable from a named target')

    const file = byFile.affected.find((n) => n.qname === 'src/util.ts')
    assert.equal(file.depth, 0)
    assert.equal(file.relation, 'target')
  })

  it('leaves a symbol target seeded as a plain target', () => {
    const bySymbol = computeImpact(wideDb, ['src/util.ts::helper'], 3, 100000)
    const helper = bySymbol.affected.find((n) => n.qname === 'src/util.ts::helper')
    assert.equal(helper.depth, 0)
    assert.equal(helper.relation, 'target')
  })
})

// ---------------------------------------------------------------------------
// the BFS binds one placeholder per frontier / visited entry, and both are
// bounded only by the size of the graph. Past SQLITE_MAX_VARIABLE_NUMBER
// (32766 on this Node build) the statement throws and the tool call fails.
//
// The graph is written straight through `writeFile`: the shape is what is under
// test, and parsing 35 000 real symbols would cost seconds for nothing.
// ---------------------------------------------------------------------------

describe('frontier and visited past the SQLite parameter limit', () => {
  const SYMBOLS = 35_000 // > 32766
  const BIG = 'src/big.ts'
  const CALLER = 'src/caller.ts'
  const limit = createFixture('cg-m6-')
  let limitDb

  const fileRow = (path) => ({
    path, hash: 'h', lang: 'ts', mtimeMs: 0, size: 0, parsedAt: 0, parseError: null,
  })
  const node = (path, qname, name, kind = 'function') => ({
    qname, kind, name, path, lang: 'ts',
    lineStart: 1, lineEnd: 1, parent: kind === 'file' ? null : path,
    signature: `${name}()`, exported: 1, isTest: 0, loc: 1,
  })

  before(() => {
    limitDb = limit.open()

    const bigNodes = [node(BIG, BIG, 'big.ts', 'file')]
    for (let i = 0; i < SYMBOLS; i += 1) {
      bigNodes.push(node(BIG, `${BIG}::f${i}`, `f${i}`))
    }
    limitDb.transaction(() => {
      limitDb.writeFile(fileRow(BIG), bigNodes, [], [])
      // Three callers reaching into the wide file, so layer 1 is not empty.
      limitDb.writeFile(
        fileRow(CALLER),
        [node(CALLER, CALLER, 'caller.ts', 'file'), node(CALLER, `${CALLER}::use`, 'use')],
        [0, 1, 2].map((i) => ({
          kind: 'CALLS', src: `${CALLER}::use`, dst: `${BIG}::f${i}`,
          path: CALLER, line: 1, resolved: 1, confidence: 1,
        })),
        [],
      )
    })
  })

  after(() => limit.cleanup())

  it('seeds a frontier wider than the parameter limit', () => {
    const r = computeImpact(limitDb, [BIG], 1, 3000)
    assert.ok(
      r.totalAffected > 32_766,
      `frontier and visited must both exceed the limit (got ${r.totalAffected})`,
    )
    assert.deepEqual(r.unresolved, [])
  })

  it('loses nothing to chunking', () => {
    const r = computeImpact(limitDb, [BIG], 1, 3000)
    // `totalAffected` counts visited nodes that metadata came back for, so one
    // exact number covers both chunked queries: every seed, plus the caller the
    // layer query has to find, minus anything a dropped metadata chunk ate.
    assert.equal(r.totalAffected, SYMBOLS + 2, 'seeds + file node + the one caller')
  })

  it('reaches the caller across the chunk boundary', () => {
    // Budgeted past the whole graph on purpose: the rows under test are at the
    // far end of a 35 000-row result and truncation would hide them.
    const r = computeImpact(limitDb, [BIG], 1, 3_000_000)
    const use = r.affected.find((n) => n.qname === `${CALLER}::use`)
    assert.ok(use, 'the caller is found through a chunked layer query')
    assert.equal(use.depth, 1)
    assert.equal(use.relation, 'CALLS')

    const names = new Set(r.affected.map((n) => n.name))
    assert.ok(names.has('f0'), 'metadata from the first chunk')
    assert.ok(names.has(`f${SYMBOLS - 1}`), 'metadata from the last chunk')
  })
})
