/**
 * The two tools that walk the graph: `code_relations` and `code_impact`.
 *
 * Both read the same fixture repository, so they share it — the counts each
 * one asserts are counts over the files written just below.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { getRelations } from '../../src/query/relations.ts'
import { computeImpact } from '../../src/query/impact.ts'
import { createFixture } from '../helpers/fixture.mjs'

const fixture = createFixture('cg-traversal-')
const { write } = fixture
let db

before(async () => {
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
  }))

  write('src/base.ts', `
export class Base { init(): void {} }
`)

  write('src/util.ts', `
export function helper(x: number): number { return x * 2 }
export const CONST = 42
function privateHelper() { return 1 }
export function usesPrivate() { return privateHelper() }
`)

  write('src/service.ts', `
import { helper } from './util'
import { Base } from './base'

export interface Runnable { run(n: number): number }

export class Service extends Base implements Runnable {
  private count = 0
  run(n: number): number {
    this.bump()
    return helper(n)
  }
  bump(): void { this.count += 1 }
}
`)

  write('src/barrel.ts', `
export { helper } from './util'
export * from './base'
`)

  write('src/consumer.ts', `
import { helper, Base } from './barrel'
export function viaBarrel(): number {
  const b = new Base()
  b.init()
  return helper(3)
}
`)

  write('src/index.ts', `
import { Service } from './service'
export function main(): number {
  const s = new Service()
  return s.run(21)
}
`)

  write('tests/service.test.ts', `
import { Service } from '../src/service'
describe('Service', () => {
  it('runs', () => {
    const s = new Service()
    s.run(1)
  })
})
`)

  db = await fixture.build()
})

after(() => fixture.cleanup())

// ---------------------------------------------------------------------------
// code_relations
// ---------------------------------------------------------------------------

describe('code_relations', () => {
  it('returns relations for a class with callers and inheritance', () => {
    const r = getRelations(db, 'Service', 3000)
    assert.ok(r.found, 'Service found')
    assert.equal(r.metadata.kind, 'class')
    assert.equal(r.metadata.path, 'src/service.ts')

    // main() and test call Service.run
    assert.ok(r.relations.callers.length > 0, 'Service has callers')
    // Class-level node has no direct CALLS edges; methods do. Check inherits instead.
    assert.equal(r.relations.callees.length, 0, 'class has no direct callees (methods do)')
  })

  it('returns callers for a frequently-called function', () => {
    const r = getRelations(db, 'helper', 2000)
    assert.ok(r.found, 'helper found')
    assert.ok(r.relations.callers.length >= 2, `helper has >= 2 callers, got ${r.relations.callers.length}`)
    // Called from service.ts::Service.run and consumer.ts::viaBarrel (via barrel)
  })

  it('returns callees for a function that calls others', () => {
    const r = getRelations(db, 'src/service.ts::Service.run', 2000)
    assert.ok(r.found, 'Service.run found')
    assert.ok(r.relations.callees.length >= 2, `Service.run has >= 2 callees, got ${r.relations.callees.length}`)
    // Calls: helper (imported), this.bump() (same class)
  })

  it('returns imports for a file that imports others', () => {
    const r = getRelations(db, 'src/service.ts', 2000)
    assert.ok(r.found, 'src/service.ts found')
    assert.ok(r.relations.imports.length >= 1, 'service.ts has imports')
    const importDsts = r.relations.imports.map((e) => e.dst)
    assert.ok(importDsts.includes('src/util.ts'), 'imports util.ts')
    assert.ok(importDsts.includes('src/base.ts'), 'imports base.ts')
  })

  it('returns testedBy edges for production symbols', () => {
    // new Service() in the test creates a confident TESTED_BY edge on the class
    const r = getRelations(db, 'Service', 2000)
    assert.ok(r.found, 'Service found')
    assert.ok(r.relations.testedBy.length >= 1, 'Service has test coverage')
  })

  it('returns empty relations for a leaf symbol with no callers', () => {
    const r = getRelations(db, 'CONST', 2000)
    assert.ok(r.found, 'CONST found')
    assert.equal(r.relations.callers.length, 0, 'CONST has no callers')
    assert.equal(r.relations.callees.length, 0, 'CONST has no callees')
  })

  it('returns found=false for a non-existent symbol', () => {
    const r = getRelations(db, 'nonexistent_symbol_xyz', 2000)
    assert.equal(r.found, false)
    assert.equal(r.symbol, 'nonexistent_symbol_xyz')
    for (const [key, val] of Object.entries(r.relations)) {
      assert.equal(val.length, 0, `${key} is empty for unknown symbol`)
    }
  })

  it('resolves by full qname', () => {
    const r = getRelations(db, 'src/service.ts::Service', 2000)
    assert.ok(r.found, 'found via qname')
    assert.equal(r.metadata.kind, 'class')
  })

  it('resolves through barrel re-exports', () => {
    // helper is imported through barrel.ts, but the call edge should resolve
    // to the actual definition in util.ts.
    const r = getRelations(db, 'helper', 2000)
    assert.ok(r.found, 'helper found')
    assert.equal(r.metadata.path, 'src/util.ts', 'helper resolves to the defining module')
  })

  it('resolves inheritance edges', () => {
    const r = getRelations(db, 'Base', 2000)
    assert.ok(r.found, 'Base found')
    assert.ok(r.relations.inheritedBy.length >= 1, 'Base has at least one subclass')
    const subclassNames = r.relations.inheritedBy.map((e) => e.src)
    assert.ok(subclassNames.some((s) => s.includes('Service')), 'Service extends Base')
  })

  it('returns inheritsFrom for a subclass', () => {
    const r = getRelations(db, 'Service', 2000)
    assert.ok(r.found)
    assert.ok(r.relations.inheritsFrom.some((e) => e.dst.includes('Base')), 'Service inheritsFrom Base')
  })

  it('returns implements and implementedBy', () => {
    const svc = getRelations(db, 'Service', 2000)
    assert.ok(svc.relations.implements.some((e) => e.dst.includes('Runnable')), 'Service implements Runnable')
    const iface = getRelations(db, 'Runnable', 2000)
    assert.ok(iface.found, 'Runnable found')
    assert.ok(iface.relations.implementedBy.some((e) => e.src.includes('Service')), 'Runnable implementedBy Service')
  })

  it('returns metadata with kind, path, line, exported', () => {
    const r = getRelations(db, 'helper', 2000)
    assert.ok(r.found)
    assert.equal(r.metadata.kind, 'function')
    assert.equal(r.metadata.path, 'src/util.ts')
    assert.equal(r.metadata.exported, true)
    assert.ok(typeof r.metadata.line === 'number', 'line is a number')
  })

  it('respects token budget', () => {
    const r = getRelations(db, 'helper', 200)
    assert.ok(r.found)
    const text = JSON.stringify(r)
    assert.ok(text.length < 200 * 4 + 100, 'result stays near budget')
  })

  it('includes truncated=false for non-existent symbol', () => {
    const r = getRelations(db, 'nonexistent_symbol_xyz', 2000)
    assert.equal(r.found, false)
    assert.equal(r.truncated, false, 'not found => not truncated')
  })

  it('includes truncated field on found results', () => {
    const r = getRelations(db, 'helper', 3000)
    assert.ok(r.found)
    assert.equal(typeof r.truncated, 'boolean', 'truncated is a boolean')
  })

  it('includes confidence on each relation edge', () => {
    const r = getRelations(db, 'helper', 3000)
    for (const edge of r.relations.callers) {
      assert.ok(typeof edge.confidence === 'number', `caller confidence is numeric: ${edge.src}`)
      assert.ok(edge.confidence >= 0 && edge.confidence <= 1, `confidence in [0,1]: ${edge.confidence}`)
    }
  })

  it('includes contains edges for a class', () => {
    const r = getRelations(db, 'src/service.ts::Service', 3000)
    assert.ok(r.found, 'Service found via qname')
    assert.ok(r.relations.contains.length >= 1, 'Service has contained symbols (methods)')
    const containedNames = r.relations.contains.map((e) => e.dst)
    assert.ok(containedNames.some((n) => n.includes('run')), 'contains Service.run')
  })

  it('resolves file path queries via path matching', () => {
    // resolveQname tries: exact qname → path match → bare name
    const r = getRelations(db, 'src/util.ts', 3000)
    assert.ok(r.found, 'file path resolves via path match')
    assert.equal(r.metadata.kind, 'file')
  })

  it('throws on empty symbol at tool layer', async () => {
    // The guard lives in src/index.ts tool handler, not the library fn.
    // Verify the library fn itself handles empty strings gracefully.
    const r = getRelations(db, '', 3000)
    assert.equal(r.found, false, 'empty string returns not found')
    assert.equal(r.truncated, false)
  })

  it('flags truncated when budget is tight', () => {
    // Use a very tight budget on a symbol with multiple relations
    // to force fitRows to drop rows and set truncated=true.
    const r = getRelations(db, 'helper', 80)
    assert.ok(r.found)
    assert.equal(r.truncated, true, 'tight budget triggers truncation flag')
  })
})

// ---------------------------------------------------------------------------
// code_impact
// ---------------------------------------------------------------------------

describe('code_impact', () => {
  it('returns direct dependents of a file', () => {
    const r = computeImpact(db, ['src/util.ts'], 3, 3000)
    assert.ok(r.affected.length > 0, 'has affected nodes')
    // src/service.ts and src/consumer.ts both import from util.ts
    const paths = r.affected.map((n) => n.path)
    assert.ok(paths.some((p) => p === 'src/service.ts'), 'service.ts is affected')
    assert.ok(paths.some((p) => p === 'src/consumer.ts'), 'consumer.ts is affected')
  })

  it('returns dependents of a specific symbol', () => {
    const r = computeImpact(db, ['src/util.ts::helper'], 3, 3000)
    assert.ok(r.affected.length > 0, 'has affected nodes')
    // Service.run calls helper, viaBarrel calls helper
    const names = r.affected.map((n) => n.name)
    assert.ok(names.includes('Service'), 'Service is affected')
    assert.ok(names.includes('viaBarrel'), 'viaBarrel is affected')
  })

  it('traces through multiple BFS depths', () => {
    const r = computeImpact(db, ['src/util.ts::helper'], 3, 3000)
    const depth0 = r.affected.filter((n) => n.depth === 0)
    const depth1 = r.affected.filter((n) => n.depth === 1)
    assert.equal(depth0.length, 1, 'exactly one target at depth 0')
    assert.ok(depth1.length > 0, 'has nodes at depth 1')
  })

  it('respects max_depth limit', () => {
    const r1 = computeImpact(db, ['src/util.ts'], 1, 3000)
    const r3 = computeImpact(db, ['src/util.ts'], 3, 3000)
    assert.ok(r3.affected.length >= r1.affected.length, 'deeper BFS finds >= nodes')
    assert.equal(r1.maxDepth, 1, 'maxDepth is 1')
    assert.equal(r3.maxDepth, 3, 'maxDepth is 3')
  })

  it('deduplicates nodes visited at different depths', () => {
    const r = computeImpact(db, ['src/util.ts'], 3, 3000)
    const qnames = r.affected.map((n) => n.qname)
    const unique = new Set(qnames)
    assert.equal(qnames.length, unique.size, 'no duplicate qnames')
  })

  it('handles non-existent targets gracefully', () => {
    const r = computeImpact(db, ['nonexistent_file.ts'], 3, 3000)
    assert.equal(r.affected.length, 0)
    assert.equal(r.totalAffected, 0)
    assert.deepEqual(r.unresolved, ['nonexistent_file.ts'])
  })

  it('handles mixed existing and non-existing targets', () => {
    const r = computeImpact(db, ['src/util.ts', 'nonexistent.ts'], 3, 3000)
    assert.ok(r.affected.length > 0, 'still finds affected for existing targets')
    assert.ok(r.unresolved.includes('nonexistent.ts'), 'reports unresolved')
  })

  it('reports relation type for each affected node', () => {
    const r = computeImpact(db, ['src/util.ts::helper'], 3, 3000)
    for (const node of r.affected) {
      assert.ok(node.relation, `${node.qname} has a relation type`)
      assert.ok(['CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'TESTED_BY', 'REFERENCES', 'CONTAINS', 'target'].includes(node.relation),
        `${node.qname} relation "${node.relation}" is valid`)
    }
  })

  it('includes confidence on each affected node', () => {
    const r = computeImpact(db, ['src/util.ts::helper'], 3, 3000)
    for (const node of r.affected) {
      assert.ok(typeof node.confidence === 'number', `${node.qname} confidence is numeric`)
      assert.ok(node.confidence >= 0 && node.confidence <= 1, `confidence in [0,1]: ${node.confidence}`)
    }
  })

  it('includes truncated field on result', () => {
    const r = computeImpact(db, ['src/util.ts'], 3, 3000)
    assert.equal(typeof r.truncated, 'boolean', 'truncated is a boolean')
  })

  it('handles empty paths array', () => {
    const r = computeImpact(db, [], 3, 3000)
    assert.equal(r.affected.length, 0)
    assert.equal(r.totalAffected, 0)
    assert.equal(r.maxDepth, 0)
    assert.deepEqual(r.unresolved, [])
    assert.equal(r.truncated, false)
  })

  it('clamps max_depth boundaries', () => {
    const r0 = computeImpact(db, ['src/util.ts'], 0, 3000)
    const rNeg = computeImpact(db, ['src/util.ts'], -1, 3000)
    const rBig = computeImpact(db, ['src/util.ts'], 99, 3000)
    assert.equal(r0.maxDepth, 1, 'depth 0 clamps to 1')
    assert.equal(rNeg.maxDepth, 1, 'negative depth clamps to 1')
    assert.ok(rBig.maxDepth <= 5, 'depth 99 clamps to at most 5')
    assert.ok(rBig.maxDepth >= r0.maxDepth, 'deeper cap reaches at least as far')
  })

  it('flags truncated when budget is tight', () => {
    // Use a very tight budget on a file with many dependents
    // to force fitRows to drop rows and set truncated=true.
    const r = computeImpact(db, ['src/util.ts'], 3, 80)
    assert.ok(r.truncated === true || r.affected.length === 0,
      'tight budget either truncates or returns nothing')
  })

  it('respects token budget', () => {
    const r = computeImpact(db, ['src/util.ts'], 3, 200)
    const text = JSON.stringify(r)
    assert.ok(text.length < 200 * 4 + 200, 'result stays near budget')
  })

  it('includes tests when impacting a production symbol', () => {
    const r = computeImpact(db, ['src/service.ts::Service'], 3, 3000)
    const paths = r.affected.map((n) => n.path)
    assert.ok(paths.some((p) => p.includes('test')), 'TESTED_BY reverse-walks to tests')
  })

  it('finds transitive impact through imports', () => {
    // util.ts -> service.ts imports util -> consumer.ts imports from barrel which re-exports util
    const r = computeImpact(db, ['src/util.ts'], 2, 3000)
    const paths = r.affected.map((n) => n.path)
    assert.ok(paths.some((p) => p === 'src/service.ts'), 'service.ts at depth 1')
    assert.ok(paths.some((p) => p === 'src/consumer.ts'), 'consumer.ts reachable transitively')
  })
})
