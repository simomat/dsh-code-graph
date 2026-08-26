/**
 * Query-driven Rust extraction: crate/mod/use, impl methods, calls, tests.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { findSymbols } from '../../src/query/find.ts'
import { overview } from '../../src/query/overview.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { assertFtsConsistent } from '../helpers/invariants.mjs'

const fixture = createFixture('cg-rust-')
const { write, all, one } = fixture
let db

before(async () => {
  write('Cargo.toml', `[package]
name = "app"
version = "0.1.0"
edition = "2021"
`)

  write('src/lib.rs', `
pub mod util;
pub mod api;
pub mod service;
pub mod consumer;
pub mod glob_user;
pub mod alias_user;
`)

  write('src/util.rs', `
pub fn double_it(x: i32) -> i32 { x * 2 }
pub fn also() -> i32 { 1 }
`)

  write('src/api.rs', `
pub trait Init {
    fn init(&self);
}
`)

  write('src/service.rs', `
pub struct Service {
    pub count: i32,
}

impl Service {
    pub fn new() -> Self {
        Service { count: 0 }
    }

    pub fn run(&self, n: i32) -> i32 {
        self.bump();
        ping();
        crate::util::double_it(n)
    }

    fn bump(&self) {}
}

impl crate::api::Init for Service {
    fn init(&self) {}
}

pub fn ping() {}

mod methods;
`)

  write('src/service/methods.rs', `
impl super::Service {
    pub fn extra(&self) {}
}
`)

  write('src/consumer.rs', `
use crate::service::{Service, ping};
use crate::util;

pub fn mainish() {
    let s = Service::new();
    s.run(21);
    let _ = util::double_it(2);
    let _ = util::also();
    let _ = ping();
    let _ = Service { count: 0 };
}
`)

  write('src/glob_user.rs', `
use crate::util::*;

pub fn via_glob() -> i32 { double_it(3) }
`)

  write('src/alias_user.rs', `
use crate::util as u;

pub fn via_alias() -> i32 { u::double_it(4) }
`)

  write('tests/it.rs', `
use app::service::Service;

#[test]
fn runs() {
    Service::new().run(1);
}
`)

  write('target/debug/build/out.rs', `
pub fn leftover() {}
`)

  db = await fixture.build()
})

after(() => fixture.cleanup())


describe('Rust query extract', () => {
  it('indexes every Rust source file except target/', () => {
    const files = one("SELECT COUNT(*) c FROM files WHERE lang='rust'").c
    assert.equal(files, 9)
    assert.equal(one("SELECT COUNT(*) c FROM files WHERE path LIKE '%target%'").c, 0)
  })

  it('extracts types, methods, and functions', () => {
    assert.ok(one("SELECT qname FROM nodes WHERE name='Service' AND kind='class'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='Init' AND kind='interface'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='run' AND kind='method' AND path LIKE '%service.rs'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='double_it' AND kind='function'"))
    assert.equal(one("SELECT exported e FROM nodes WHERE name='bump' AND kind='method'").e, 0)
    assert.equal(one("SELECT exported e FROM nodes WHERE name='run' AND kind='method'").e, 1)
  })

  it('parents a cross-file impl method on the type\'s declaring file', () => {
    const row = one("SELECT qname, parent, path FROM nodes WHERE name='extra' AND kind='method'")
    assert.ok(row)
    assert.match(row.parent, /service\.rs::Service$/)
    assert.match(row.path, /methods\.rs$/)
    assert.match(row.qname, /Service\.extra$/)
  })

  it('resolves crate:: use paths', () => {
    const row = one(
      "SELECT resolved_path r FROM imports WHERE path LIKE '%consumer.rs' AND spec='crate::util' AND resolved_path IS NOT NULL",
    )
    assert.equal(row.r, 'src/util.rs')
  })

  it('creates file-level IMPORTS edges to the used module', () => {
    const edge = one(`
      SELECT COUNT(*) c FROM edges
      WHERE kind='IMPORTS'
        AND src='src/consumer.rs'
        AND dst='src/util.rs'
    `)
    assert.equal(edge.c, 1)
  })
})

describe('Rust call resolution', () => {
  it('resolves util::double_it through a module use', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%consumer.rs::mainish'
        AND dst LIKE '%double_it'
    `)
    assert.ok(edge, 'mainish -> util::double_it')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves a function in the same used module', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%consumer.rs::mainish'
        AND dst LIKE '%also'
    `)
    assert.ok(edge, 'mainish -> util::also')
    assert.equal(edge.confidence, 1)
  })

  it('resolves Service::new through a named use', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%consumer.rs::mainish'
        AND dst LIKE '%Service.new'
    `)
    assert.ok(edge, 'Service::new()')
    assert.equal(edge.confidence, 1)
  })

  it('rewrites self.m() inside a method to this.m()', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%Service.bump'
    `)
    assert.ok(edge, 'self.bump()')
    assert.equal(edge.confidence, 0.8)
  })

  it('resolves crate::util::double_it without a use', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%double_it'
    `)
    assert.ok(edge, 'crate::util::double_it')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves a same-module function without a use', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%::ping'
    `)
    assert.ok(edge, 'ping() in the same module')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 0.9)
  })

  it('resolves a struct expression on an imported type', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%consumer.rs::mainish'
        AND dst LIKE '%service.rs::Service'
    `)
    assert.ok(edge, 'Service { .. }')
    assert.equal(edge.confidence, 1)
  })

  it('resolves a glob use', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%via_glob'
        AND dst LIKE '%double_it'
    `)
    assert.ok(edge, 'use crate::util::*; double_it()')
    assert.equal(edge.confidence, 1)
  })

  it('resolves an aliased module use', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%via_alias'
        AND dst LIKE '%double_it'
    `)
    assert.ok(edge, 'use crate::util as u; u::double_it()')
    assert.equal(edge.confidence, 1)
  })

  it('records impl Trait for Type', () => {
    const impl = one("SELECT * FROM edges WHERE kind='IMPLEMENTS' AND src LIKE '%service.rs::Service'")
    assert.ok(impl)
    assert.ok(impl.dst.includes('Init'))
    assert.equal(impl.resolved, 1)
  })

  it('never fabricates an edge for an unknown target', () => {
    const bogus = all("SELECT * FROM edges WHERE resolved=1 AND dst NOT IN (SELECT qname FROM nodes)")
    assert.equal(bogus.length, 0)
  })
})

describe('Rust tests and query tools', () => {
  it('marks tests/ integration test files', () => {
    assert.equal(
      one("SELECT is_test t FROM nodes WHERE path LIKE '%tests/it.rs' AND kind='file'").t,
      1,
    )
  })

  it('finds a Rust function by name', () => {
    const r = findSymbols(db, { query: 'double_it', budget: 1500 })
    const hit = r.rows.find((h) => h.name === 'double_it')
    assert.ok(hit)
    assert.match(hit.path, /util\.rs$/)
    assert.equal(hit.kind, 'function')
  })

  it('lists rust in overview languages', () => {
    const o = overview(db, undefined, 1500)
    assert.ok(o.languages.some((l) => l.lang === 'rust'))
    assert.equal(o.totals.files, 9)
  })

  it('never reports an FTS hit the node does not contain', () => {
    assertFtsConsistent(db, 'rust fixture')
  })
})

describe('Rust type signatures', () => {
  it('names the type with its declaration keyword', () => {
    const rows = db.db
      .prepare("SELECT name, kind, signature FROM nodes WHERE kind IN ('class','interface','enum','type')")
      .all()
    assert.ok(rows.length > 0, 'the fixture really has types')
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.signature]))
    assert.equal(byName.Service, 'struct Service')
    assert.equal(byName.Init, 'trait Init')
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

describe('Rust keeps user-defined method names the JS noise list drops', () => {
  const rs = createFixture('cg-m20-rs-')
  let rsDb

  before(async () => {
    const put = rs.write
    put('Cargo.toml', '[package]\nname = "noise"\nversion = "0.1.0"\n')
    // Each of these names is declared on two types, so the call is ambiguous
    // and reaches the noise check unresolved.
    put('src/store.rs', `
pub struct File;

impl File {
    pub fn close(&self) {}
    pub fn parse(&self) {}
    pub fn get(&self) -> usize { 0 }
}

pub struct Conn;

impl Conn {
    pub fn close(&self) {}
    pub fn parse(&self) {}
    pub fn get(&self) -> usize { 1 }
}
`)
    put('src/lib.rs', `
pub mod store;

use store::File;

pub fn drain(f: &File, raw: &str) -> usize {
    f.close();
    f.parse();
    let text = raw.to_string();
    let _ = text.len();
    f.get()
}
`)
    rsDb = await rs.build()
  })

  after(() => rs.cleanup())

  const targets = () => rsDb.db
    .prepare('SELECT dst FROM edges WHERE src = ? AND resolved = 0 ORDER BY dst')
    .all('src/lib.rs::drain')
    .map((r) => r.dst)

  it('keeps an unresolved call to a user-defined close/parse/get', () => {
    const dsts = targets()
    for (const name of ['close', 'parse', 'get']) {
      assert.ok(dsts.includes(name), `${name} was dropped as noise: ${dsts.join(', ')}`)
    }
  })

  it('still drops a genuine Rust std call', () => {
    assert.equal(targets().includes('to_string'), false, 'to_string is Rust noise')
  })

  it('keeps a name std shares with ordinary user methods', () => {
    // `len` is std here, but the Rust list deliberately omits it: dropping it
    // would also drop every project method called `len`.
    assert.ok(targets().includes('len'), targets().join(', '))
  })
})
