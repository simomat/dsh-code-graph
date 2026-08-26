/**
 * Indexing a TypeScript repository, end to end.
 *
 * One purpose-built fixture carries the whole language surface — declarations,
 * every import binding form, calls through barrels and inheritance, and the
 * test-file linkage — so the assertions are exact counts rather than whatever
 * a real checkout happens to contain. The read tools are asserted here too:
 * they answer over this same graph, and moving them elsewhere would mean a
 * second copy of the fixture that could drift from this one.
 *
 * The suites below it bring their own smaller fixtures for the cases that need
 * a repository shaped differently.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { incrementalBuild } from '../../src/index/build.ts'
import { computeImpact } from '../../src/query/impact.ts'
import { findSymbols } from '../../src/query/find.ts'
import { overview } from '../../src/query/overview.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { assertFtsConsistent } from '../helpers/invariants.mjs'

const fixture = createFixture('cg-typescript-')
const { write, all, one } = fixture
let db

before(async () => {
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
  }))

  write('src/util.ts', `
export function helper(x: number): number { return x * 2 }
export const CONST = 42
function privateHelper() { return 1 }
export function usesPrivate() { return privateHelper() }
function listed(): number { return 0 }
export { listed }
export default function defaultHelper(): number { return 1 }
`)

  write('src/service.ts', `
import { helper } from './util'
import { Base } from '@app/base'

export class Service extends Base implements Runnable {
  private count = 0
  run(n: number): number {
    this.bump()
    this.init()
    return helper(n)
  }
  bump(): void { this.count += 1 }
}
`)

  write('src/base.ts', `
export class Base { init(): void {} }
`)

  // A barrel re-exporting both by name and wholesale, plus a consumer importing
  // through it — the pattern that dominates package-per-directory repositories.
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

  write('src/bindings.ts', `
import defaultHelper from './util'
import { helper as h } from './util'
import * as u from './util'
export function usesAlias(): number { return h(1) }
export function usesDefault(): number { return defaultHelper() }
export function usesNs(): number { return u.helper(2) }
`)

  write('src/unique.ts', `
export function onlyFn(): void {}
export class OnlyClass {}
export function constructsWrong(): void { new onlyFn() }
export function callsClass(): void { OnlyClass() }
export function constructsClass(): OnlyClass { return new OnlyClass() }
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

describe('build', () => {
  it('indexes every source file', () => {
    const files = one("SELECT COUNT(*) c FROM nodes WHERE kind='file'").c
    assert.equal(files, 9, 'every fixture source is indexed')
  })

  it('extracts declarations with correct kinds', () => {
    const kinds = Object.fromEntries(
      all("SELECT kind, COUNT(*) c FROM nodes WHERE kind!='file' GROUP BY kind").map((r) => [r.kind, r.c]),
    )
    assert.ok(kinds.function >= 4, `functions extracted (got ${kinds.function})`)
    assert.ok(kinds.class >= 2, 'Service and Base')
    assert.ok(kinds.method >= 3, `methods extracted (got ${kinds.method})`)
  })

  it('records exact line numbers', () => {
    const helper = one("SELECT * FROM nodes WHERE name='helper' AND kind='function'")
    assert.ok(helper, 'helper exists')
    assert.equal(helper.path, 'src/util.ts')
    assert.equal(helper.line_start, 2)
  })

  it('marks exported symbols', () => {
    assert.equal(one("SELECT exported e FROM nodes WHERE name='helper'").e, 1)
    assert.equal(one("SELECT exported e FROM nodes WHERE name='privateHelper'").e, 0)
  })
})

describe('import resolution', () => {
  it('resolves relative specifiers', () => {
    const row = one("SELECT resolved_path r FROM imports WHERE path='src/service.ts' AND spec='./util'")
    assert.equal(row.r, 'src/util.ts')
  })

  it('resolves tsconfig path aliases', () => {
    const row = one("SELECT resolved_path r FROM imports WHERE path='src/service.ts' AND spec='@app/base'")
    assert.equal(row.r, 'src/base.ts', 'the @app/* alias resolves to src/*')
  })

  it('creates file-level IMPORTS edges', () => {
    const edge = one(
      "SELECT COUNT(*) c FROM edges WHERE kind='IMPORTS' AND src='src/service.ts' AND dst='src/util.ts'",
    )
    assert.equal(edge.c, 1)
  })
})

describe('call resolution', () => {
  it('resolves an imported call at full confidence', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/service.ts::Service.run' AND dst='src/util.ts::helper'
    `)
    assert.ok(edge, 'Service.run -> helper edge exists')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves a same-file call', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/util.ts::usesPrivate' AND dst='src/util.ts::privateHelper'
    `)
    assert.ok(edge, 'usesPrivate -> privateHelper edge exists')
    assert.equal(edge.confidence, 0.9)
  })

  it('resolves this.method() on an inherited member', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/service.ts::Service.run' AND dst='src/base.ts::Base.init'
    `)
    assert.ok(edge, 'this.init() follows INHERITS to Base.init')
    assert.equal(edge.confidence, 0.8)
  })

  it('resolves an aliased named import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/bindings.ts::usesAlias' AND dst='src/util.ts::helper'
    `)
    assert.ok(edge, 'import { helper as h }; h() resolves to helper')
    assert.equal(edge.confidence, 1)
  })

  it('resolves a default import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/bindings.ts::usesDefault' AND dst='src/util.ts::defaultHelper'
    `)
    assert.ok(edge, 'import defaultHelper from util')
    assert.equal(edge.confidence, 1)
  })

  it('resolves a namespace import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/bindings.ts::usesNs' AND dst='src/util.ts::helper'
    `)
    assert.ok(edge, 'import * as u; u.helper()')
    assert.equal(edge.confidence, 1)
  })

  it('marks export { listed } as exported', () => {
    assert.equal(one("SELECT exported e FROM nodes WHERE name='listed' AND kind='function'").e, 1)
  })

  it('does not resolve new fn() at 0.5 onto a unique function', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/unique.ts::constructsWrong' AND dst='src/unique.ts::onlyFn'
        AND confidence = 0.5
    `)
    assert.equal(edge, undefined, 'construction must land on a class')
  })

  it('does not resolve Class() at 0.5 onto a unique class', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/unique.ts::callsClass' AND dst='src/unique.ts::OnlyClass'
        AND confidence = 0.5
    `)
    assert.equal(edge, undefined, 'plain call must not land on a class')
  })

  it('resolves this.method() within the class', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/service.ts::Service.run' AND dst='src/service.ts::Service.bump'
    `)
    assert.ok(edge, 'this.bump() resolves to the sibling method')
    assert.equal(edge.confidence, 0.8)
  })

  it('records inheritance and interfaces', () => {
    const inherits = one(
      "SELECT * FROM edges WHERE kind='INHERITS' AND src='src/service.ts::Service'",
    )
    assert.equal(inherits.dst, 'src/base.ts::Base', 'extends resolves across the alias import')
    assert.equal(inherits.resolved, 1)

    const impl = one("SELECT * FROM edges WHERE kind='IMPLEMENTS' AND src='src/service.ts::Service'")
    assert.equal(impl.dst, 'Runnable', 'an unknown interface stays an unresolved bare name')
    assert.equal(impl.resolved, 0)
  })

  it('resolves a call imported through a barrel at full confidence', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/consumer.ts::viaBarrel' AND dst='src/util.ts::helper'
    `)
    assert.ok(edge, 'the named re-export is followed to the defining module')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1, 'not demoted to a global-name guess')
  })

  it('follows a star re-export', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS' AND src='src/consumer.ts::viaBarrel' AND dst='src/base.ts::Base'
    `)
    assert.ok(edge, 'export * republishes Base through the barrel')
    assert.equal(edge.confidence, 1)
  })

  it('never fabricates an edge for an unknown target', () => {
    const bogus = all("SELECT * FROM edges WHERE resolved=1 AND dst NOT IN (SELECT qname FROM nodes)")
    assert.equal(bogus.length, 0, 'every resolved edge points at a real node')
  })

  it('drops builtin method noise', () => {
    const noise = all("SELECT * FROM edges WHERE dst IN ('push','map','toBe','get')")
    assert.equal(noise.length, 0)
  })
})

describe('tests linkage', () => {
  it('marks test files', () => {
    assert.equal(one("SELECT is_test t FROM nodes WHERE path='tests/service.test.ts' AND kind='file'").t, 1)
  })

  it('links production symbols to their tests', () => {
    const links = all("SELECT * FROM edges WHERE kind='TESTED_BY'")
    assert.ok(links.length > 0, 'at least one TESTED_BY edge')
    for (const l of links) {
      assert.ok(l.confidence >= 0.8, 'only confident coverage links')
      const srcTest = one('SELECT is_test t FROM nodes WHERE qname = ?', l.src).t
      const dstTest = one('SELECT is_test t FROM nodes WHERE qname = ?', l.dst).t
      assert.equal(srcTest, 1, 'TESTED_BY src is the test')
      assert.equal(dstTest, 0, 'TESTED_BY dst is production')
    }
  })
})

describe('code_find', () => {
  it('finds a symbol by exact name with its signature and line', () => {
    const r = findSymbols(db, { query: 'helper', budget: 1500 })
    const hit = r.rows.find((h) => h.name === 'helper')
    assert.ok(hit, 'helper found')
    assert.equal(hit.path, 'src/util.ts')
    assert.equal(hit.line, 2)
    assert.match(hit.signature, /helper/)
    assert.equal(hit.exported, true)
  })

  it('ranks the exact match first', () => {
    const r = findSymbols(db, { query: 'Service', budget: 1500 })
    assert.equal(r.rows[0].name, 'Service')
  })

  it('filters by kind and path glob', () => {
    const byKind = findSymbols(db, { query: 'Service', kind: 'class', budget: 1500 })
    assert.ok(byKind.rows.every((h) => h.kind === 'class'))

    const byPath = findSymbols(db, { query: 'helper', pathGlob: 'src/*', budget: 1500 })
    assert.ok(byPath.rows.every((h) => h.path.startsWith('src/')))
  })

  it('reports caller counts', () => {
    const r = findSymbols(db, { query: 'helper', budget: 1500 })
    const hit = r.rows.find((h) => h.name === 'helper')
    assert.ok(hit.callers >= 1, 'helper has a caller')
  })

  it('returns no file bodies', () => {
    const r = findSymbols(db, { query: 'Service', budget: 1500 })
    const text = JSON.stringify(r.rows)
    assert.ok(!text.includes('this.count += 1'), 'signatures only, never source bodies')
  })

  it('degrades gracefully on a punctuation-only query', () => {
    const r = findSymbols(db, { query: '***', budget: 1500 })
    assert.ok(Array.isArray(r.rows), 'returns a result rather than throwing')
  })

  it('reports total matches, not the page size', () => {
    const r = findSymbols(db, { query: 'uses', limit: 1, budget: 1500 })
    assert.equal(r.rows.length, 1)
    assert.ok(r.total > 1, `total (${r.total}) is the corpus size, not LIMIT`)
  })

  it('never reports an FTS hit the node does not contain', () => {
    assertFtsConsistent(db, 'typescript fixture')
  })
})

describe('code_overview', () => {
  it('summarizes the repository', () => {
    const o = overview(db, undefined, 1500)
    assert.equal(o.status, 'ready')
    assert.equal(o.totals.files, 9)
    assert.ok(o.totals.symbols > 0)
    assert.ok(o.totals.callResolution > 0.5, 'most calls resolve in a clean fixture')
    assert.ok(o.languages.some((l) => l.lang === 'typescript'))
  })

  it('suggests next steps', () => {
    const o = overview(db, undefined, 1500)
    assert.ok(o.next.length > 0)
  })

  it('scopes to a focus directory', () => {
    const o = overview(db, 'src', 1500)
    assert.equal(o.focus, 'src')
    assert.equal(o.totals.files, 8, 'the tests directory is excluded')
  })

  it('groups modules by directory, not filename', () => {
    const o = overview(db, undefined, 1500)
    assert.ok(o.modules.some((m) => m.dir === 'src'), 'src is a module')
    assert.ok(o.modules.every((m) => !m.dir.endsWith('.ts')), 'modules are directories')
  })
})

describe('nested declarations are visible to the graph', () => {
  const fx = createFixture('cg-m18-')
  let db

  before(async () => {
    fx.write('src/sink.ts', 'export function sink(n: number): number { return n }\n')
    fx.write('src/nested.ts', `
import { sink } from './sink.ts'

export function outer(): number {
  function helper(): number { return sink(1) }
  const arrow = () => sink(2)
  const plain = sink(3)
  return helper() + arrow() + plain
}

export const wrapper = () => {
  class Inner {
    run(): number { return sink(4) }
  }
  return new Inner().run()
}
`)
    db = await fx.build()
  })

  after(() => fx.cleanup())

  const qnames = (kind) => db.db
    .prepare('SELECT qname FROM nodes WHERE kind = ? ORDER BY qname')
    .all(kind)
    .map((r) => r.qname)

  const callers = (dst) => db.db
    .prepare("SELECT src FROM edges WHERE kind = 'CALLS' AND dst = ? ORDER BY src")
    .all(dst)
    .map((r) => r.src)

  it('emits a nested function with a scope-encoded qname', () => {
    const fns = qnames('function')
    assert.ok(fns.includes('src/nested.ts::outer.helper'), fns.join(', '))
    assert.ok(fns.includes('src/nested.ts::outer.arrow'), fns.join(', '))
  })

  it('emits a class declared inside a function, with its methods', () => {
    assert.ok(qnames('class').includes('src/nested.ts::wrapper.Inner'))
    assert.ok(qnames('method').includes('src/nested.ts::wrapper.Inner.run'))
  })

  it('finds a nested function through code_find', () => {
    const hit = findSymbols(db, { query: 'helper', budget: 1500 }).rows
      .find((r) => r.qname === 'src/nested.ts::outer.helper')
    assert.ok(hit, 'nested helper not found')
    assert.equal(hit.kind, 'function')
  })

  it('attributes a nested declaration\'s calls to itself, not to the enclosing owner', () => {
    const src = callers('src/sink.ts::sink')
    assert.ok(src.includes('src/nested.ts::outer.helper'))
    // The concise arrow body *is* the call — it must not be dropped.
    assert.ok(src.includes('src/nested.ts::outer.arrow'))
    assert.ok(src.includes('src/nested.ts::wrapper.Inner.run'))
    // A non-function local keeps attributing its initializer to the owner.
    assert.ok(src.includes('src/nested.ts::outer'))
  })

  it('keeps the enclosing declaration reachable through CONTAINS', () => {
    const contains = db.db
      .prepare("SELECT src FROM edges WHERE kind = 'CONTAINS' AND dst = ?")
      .all('src/nested.ts::outer.helper')
      .map((r) => r.src)
    assert.deepEqual(contains, ['src/nested.ts::outer'])

    const impact = computeImpact(db, ['src/sink.ts::sink'], 3, 6000)
    const reached = new Set(impact.affected.map((a) => a.qname))
    assert.ok(reached.has('src/nested.ts::outer.helper'))
    assert.ok(reached.has('src/nested.ts::outer'))
    assert.ok(reached.has('src/nested.ts::wrapper'))
  })

  it('does not emit a node for a plain local binding', () => {
    const vars = qnames('var')
    assert.ok(!vars.some((q) => q.includes('outer.plain')), vars.join(', '))
  })

  it('keeps the FTS index consistent', () => {
    assertFtsConsistent(db)
  })
})

// ---------------------------------------------------------------------------
// test-file heuristic
// ---------------------------------------------------------------------------

describe('test-file heuristic needs corroboration', () => {
  const fx = createFixture('cg-m19-')
  let db

  before(async () => {
    // A production file whose own helper is called `test()`. One receiverless
    // call to a framework name used to mark the whole file.
    fx.write('src/validate.ts', `
export function test(value: string): boolean {
  return value.length > 0
}

export function validate(value: string): string {
  if (!test(value)) throw new Error('empty')
  return value
}
`)
    // A production file calling an imported helper that happens to be named
    // \`it\` — imported, but not from a test runner.
    fx.write('src/iterate.ts', `
import { it } from './dsl.ts'

export function run(): number {
  return it(3)
}
`)
    fx.write('src/dsl.ts', 'export function it(n: number): number { return n }\n')
    // A real test file outside the conventional paths: single framework name,
    // corroborated by the module it comes from.
    fx.write('src/checks.ts', `
import { test } from 'node:test'
import { validate } from './validate.ts'

test('validate', () => {
  validate('x')
})
`)
    // A real test file with runner-injected globals: nothing imported, two
    // distinct framework names.
    fx.write('src/globals.ts', `
import { validate } from './validate.ts'

describe('validate', () => {
  it('accepts', () => {
    validate('x')
  })
})
`)
    db = await fx.build()
  })

  after(() => fx.cleanup())

  const isTest = (path) => db.db
    .prepare('SELECT DISTINCT is_test FROM nodes WHERE path = ?')
    .all(path)
    .map((r) => r.is_test)

  it('does not mark a file whose own helper is named test()', () => {
    assert.deepEqual(isTest('src/validate.ts'), [0])
  })

  it('does not mark a file calling a framework-named helper from elsewhere', () => {
    assert.deepEqual(isTest('src/iterate.ts'), [0])
  })

  it('marks a file importing a test runner', () => {
    assert.deepEqual(isTest('src/checks.ts'), [1])
  })

  it('marks a file using two distinct injected globals', () => {
    assert.deepEqual(isTest('src/globals.ts'), [1])
  })

  it('keeps the unmarked production file in hubs', () => {
    const hubs = overview(db, undefined, 3000).hubs.map((h) => h.qname)
    assert.ok(hubs.includes('src/validate.ts::validate'), hubs.join(', '))
  })

  it('still records TESTED_BY from a genuine test file', () => {
    const tested = db.db
      .prepare("SELECT src FROM edges WHERE kind = 'TESTED_BY' AND dst = ? ORDER BY src")
      .all('src/validate.ts::validate')
      .map((r) => r.src)
    assert.ok(tested.length > 0, 'a corroborated test file still produces TESTED_BY')
  })
})

// ---------------------------------------------------------------------------
// the edge rewrite resolved every file twice: once to harvest INHERITS
// into the class-parent map, once for real. The harvest now resolves heritage
// alone, so `this.m()` against an inherited member must still land — including
// when the file that changed is not the one declaring the inheritance.
// ---------------------------------------------------------------------------

describe('inherited this.m() survives the single-pass rewrite', () => {
  const m7 = createFixture('cg-m7-')
  const m7Root = m7.root
  const w = m7.write
  let m7Db

  const inheritedCalls = () => m7Db.db.prepare(
    `SELECT src FROM edges
     WHERE kind = 'CALLS' AND dst = 'src/base.ts::Base.init' AND resolved = 1
     ORDER BY src`,
  ).all().map((r) => r.src)

  before(async () => {
    w('src/base.ts', 'export class Base { init(): void {} }\n')
    w('src/service.ts', [
      "import { Base } from './base'",
      'export class Service extends Base {',
      '  run(): void { this.init() }',
      '}',
      '',
    ].join('\n'))
    m7Db = await m7.build()
  })

  after(() => m7.cleanup())

  it('resolves through the base class after a full build', () => {
    assert.deepEqual(inheritedCalls(), ['src/service.ts::Service.run'])
  })

  it('still resolves after the subclass is re-indexed', async () => {
    w('src/service.ts', [
      "import { Base } from './base'",
      'export class Service extends Base {',
      '  run(): void { this.init() }',
      '  again(): void { this.init() }',
      '}',
      '',
    ].join('\n'))
    await incrementalBuild(m7Db, m7Root, ['src/service.ts'])
    assert.deepEqual(
      inheritedCalls(),
      ['src/service.ts::Service.again', 'src/service.ts::Service.run'],
      'both call sites follow INHERITS to Base.init',
    )
  })

  it('still resolves when only the base class file is re-indexed', async () => {
    // service.ts is not reparsed here: its calls and its `extends` clause both
    // come back from the persisted rows, and the heritage-only pass has to
    // rebuild the class-parent map from them.
    w('src/base.ts', 'export class Base { init(): void {} }\n// touched\n')
    await incrementalBuild(m7Db, m7Root, ['src/base.ts'])
    assert.deepEqual(
      inheritedCalls(),
      ['src/service.ts::Service.again', 'src/service.ts::Service.run'],
    )
  })
})
