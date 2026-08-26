/**
 * Query-driven Go extraction: package imports, methods, calls, tests.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { findSymbols } from '../../src/query/find.ts'
import { overview } from '../../src/query/overview.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { assertFtsConsistent } from '../helpers/invariants.mjs'

const fixture = createFixture('cg-go-')
const { write, all, one } = fixture
let db

before(async () => {
  write('go.mod', 'module example.com/app\n\ngo 1.22\n')

  write('util/helper.go', `
package util

func DoubleIt(x int) int { return x * 2 }
`)

  write('util/extra.go', `
package util

func Also() int { return 1 }
`)

  write('service/service.go', `
package service

type Service struct {
	count int
}

func New() *Service { return &Service{} }

func (s *Service) Run(n int) int {
	s.bump()
	Ping()
	return helperDouble(n)
}

func (s *Service) bump() { s.count += 1 }

func helperDouble(n int) int { return n }
`)

  write('service/same.go', `
package service

func Ping() {}
`)

  write('service/methods.go', `
package service

func (s *Service) Extra() {}
`)

  write('app/main.go', `
package main

import (
	"example.com/app/service"
	"example.com/app/util"
)

func main() {
	s := service.New()
	s.Run(21)
	_ = util.DoubleIt(2)
	_ = util.Also()
	_ = service.Service{}
}
`)

  write('app/dot.go', `
package main

import . "example.com/app/util"

func ViaDot() int { return DoubleIt(3) }
`)

  write('app/alias.go', `
package main

import u "example.com/app/util"

func ViaAlias() int { return u.DoubleIt(4) }
`)

  write('service/service_test.go', `
package service

func TestRun() {
	New().Run(1)
}
`)

  write('vendor/example.com/hidden/hidden.go', `
package hidden
func Secret() {}
`)

  db = await fixture.build()
})

after(() => fixture.cleanup())


describe('Go query extract', () => {
  it('indexes every Go source file except vendor', () => {
    const files = one("SELECT COUNT(*) c FROM files WHERE lang='go'").c
    assert.equal(files, 9)
    assert.equal(one("SELECT COUNT(*) c FROM files WHERE path LIKE '%vendor%'").c, 0)
  })

  it('extracts types, methods, and functions', () => {
    assert.ok(one("SELECT qname FROM nodes WHERE name='Service' AND kind='class'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='Run' AND kind='method' AND path LIKE '%service.go'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='New' AND kind='function'"))
    assert.equal(one("SELECT exported e FROM nodes WHERE name='bump' AND kind='method'").e, 0)
    assert.equal(one("SELECT exported e FROM nodes WHERE name='Run' AND kind='method'").e, 1)
  })

  it('parents a cross-file method on the type\'s declaring file', () => {
    const row = one("SELECT qname, parent, path FROM nodes WHERE name='Extra' AND kind='method'")
    assert.ok(row)
    assert.match(row.parent, /service\.go::Service$/)
    assert.match(row.path, /methods\.go$/)
    assert.match(row.qname, /Service\.Extra$/)
  })

  it('resolves package-path imports', () => {
    const row = one(
      "SELECT resolved_path r FROM imports WHERE path LIKE '%main.go' AND spec='example.com/app/util' AND resolved_path IS NOT NULL",
    )
    assert.match(row.r, /^util\//)
  })

  it('creates file-level IMPORTS edges to the imported package', () => {
    const edge = one(`
      SELECT COUNT(*) c FROM edges
      WHERE kind='IMPORTS'
        AND src='app/main.go'
        AND dst LIKE 'util/%'
    `)
    assert.ok(edge.c >= 1)
  })
})

describe('Go call resolution', () => {
  it('resolves util.DoubleIt through a package import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%main.go::main'
        AND dst LIKE '%DoubleIt'
    `)
    assert.ok(edge, 'main -> util.DoubleIt')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves a function in another file of the same imported package', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%main.go::main'
        AND dst LIKE '%Also'
    `)
    assert.ok(edge, 'main -> util.Also')
    assert.equal(edge.confidence, 1)
  })

  it('resolves service.New through a package import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%main.go::main'
        AND dst LIKE '%::New'
    `)
    assert.ok(edge, 'service.New()')
    assert.equal(edge.confidence, 1)
  })

  it('rewrites receiver calls inside a method to this.m()', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.Run'
        AND dst LIKE '%Service.bump'
    `)
    assert.ok(edge, 's.bump()')
    assert.equal(edge.confidence, 0.8)
  })

  it('resolves a same-package function without an import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.Run'
        AND dst LIKE '%::Ping'
    `)
    assert.ok(edge, 'Ping() is visible in-package')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves a composite literal on an imported type', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%main.go::main'
        AND dst LIKE '%service.go::Service'
    `)
    assert.ok(edge, 'service.Service{}')
    assert.equal(edge.confidence, 1)
  })

  it('resolves a dot import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%ViaDot'
        AND dst LIKE '%DoubleIt'
    `)
    assert.ok(edge, 'import . util; DoubleIt()')
    assert.equal(edge.confidence, 1)
  })

  it('resolves an aliased package import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%ViaAlias'
        AND dst LIKE '%DoubleIt'
    `)
    assert.ok(edge, 'import u; u.DoubleIt()')
    assert.equal(edge.confidence, 1)
  })

  it('never fabricates an edge for an unknown target', () => {
    const bogus = all("SELECT * FROM edges WHERE resolved=1 AND dst NOT IN (SELECT qname FROM nodes)")
    assert.equal(bogus.length, 0)
  })
})

describe('Go tests and query tools', () => {
  it('marks _test.go files', () => {
    assert.equal(
      one("SELECT is_test t FROM nodes WHERE path LIKE '%service_test.go' AND kind='file'").t,
      1,
    )
  })

  it('finds a Go function by name', () => {
    const r = findSymbols(db, { query: 'DoubleIt', budget: 1500 })
    const hit = r.rows.find((h) => h.name === 'DoubleIt')
    assert.ok(hit)
    assert.match(hit.path, /helper\.go$/)
    assert.equal(hit.kind, 'function')
  })

  it('lists go in overview languages', () => {
    const o = overview(db, undefined, 1500)
    assert.ok(o.languages.some((l) => l.lang === 'go'))
    assert.equal(o.totals.files, 9)
  })

  it('never reports an FTS hit the node does not contain', () => {
    assertFtsConsistent(db, 'go fixture')
  })
})

describe('Go type signatures', () => {
  it('names the type and its shape, not its fields', () => {
    const rows = db.db
      .prepare("SELECT name, kind, signature FROM nodes WHERE kind IN ('class','interface','type')")
      .all()
    assert.ok(rows.length > 0, 'the fixture really has types')
    const service = rows.find((r) => r.name === 'Service')
    assert.equal(service.signature, 'type Service struct')
    for (const r of rows) {
      assert.equal(r.signature.includes('{'), false, `${r.name} quotes its body: ${r.signature}`)
      assert.ok(r.signature.length <= 60, `${r.name} signature is compact`)
    }
  })

  it('keeps a field name out of the struct\'s search text', () => {
    const hits = findSymbols(db, { query: 'count', budget: 1500 }).rows
    assert.equal(hits.some((h) => h.name === 'Service'), false, 'the struct is not a hit for its field')
  })
})

// ---------------------------------------------------------------------------
// the noise list is per-language
// ---------------------------------------------------------------------------

describe('Go keeps user-defined method names the JS noise list drops', () => {
  const go = createFixture('cg-m20-go-')
  let goDb

  before(async () => {
    const put = go.write
    put('go.mod', 'module example.com/noise\n\ngo 1.22\n')
    // `close`, `parse` and `get` are declared on two types each, so a call to
    // one is genuinely ambiguous — which is exactly the path where the noise
    // list decides between an honest REFERENCES edge and silent deletion.
    put('store/store.go', `
package store

type File struct{}

func (f *File) close() {}
func (f *File) parse() {}
func (f *File) get() int { return 0 }

type Conn struct{}

func (c *Conn) close() {}
func (c *Conn) parse() {}
func (c *Conn) get() int { return 1 }
`)
    put('store/use.go', `
package store

import "fmt"

func Drain(f *File) int {
	f.close()
	f.parse()
	fmt.Println("draining")
	return f.get()
}
`)
    goDb = await go.build()
  })

  after(() => go.cleanup())

  const targets = () => goDb.db
    .prepare("SELECT dst FROM edges WHERE src = ? AND resolved = 0 ORDER BY dst")
    .all('store/use.go::Drain')
    .map((r) => r.dst)

  it('keeps an unresolved call to a user-defined close/parse/get', () => {
    const dsts = targets()
    for (const name of ['close', 'parse', 'get']) {
      assert.ok(dsts.includes(name), `${name} was dropped as noise: ${dsts.join(', ')}`)
    }
  })

  it('still drops a genuine Go stdlib call', () => {
    assert.equal(targets().includes('Println'), false, 'fmt.Println is Go noise')
  })
})
