/**
 * Query-driven Java extraction: declarations, FQCN imports, calls, heritage.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { incrementalBuild } from '../../src/index/build.ts'
import { findSymbols } from '../../src/query/find.ts'
import { overview } from '../../src/query/overview.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { assertFtsConsistent } from '../helpers/invariants.mjs'

const fixture = createFixture('cg-java-')
const { write, all, one } = fixture
let db

before(async () => {
  write('src/main/java/com/example/base/Base.java', `
package com.example.base;
public class Base {
  public void init() {}
}
`)

  write('src/main/java/com/example/util/Helper.java', `
package com.example.util;
public class Helper {
  public static int doubleIt(int x) { return x * 2; }
}
`)

  write('src/main/java/com/example/api/Runnable.java', `
package com.example.api;
public interface Runnable {
  int run(int n);
}
`)

  write('src/main/java/com/example/service/SamePkg.java', `
package com.example.service;
public class SamePkg {
  public static void ping() {}
}
`)

  write('src/main/java/com/example/service/Service.java', `
package com.example.service;
import com.example.base.Base;
import com.example.util.Helper;
import com.example.api.Runnable;
public class Service extends Base implements Runnable {
  private int count = 0;
  public int run(int n) {
    this.bump();
    this.init();
    SamePkg.ping();
    return Helper.doubleIt(n);
  }
  void bump() { this.count += 1; }
}
`)

  write('src/main/java/com/example/app/Main.java', `
package com.example.app;
import com.example.service.Service;
public class Main {
  public static void main(String[] args) {
    Service s = new Service();
    s.run(21);
  }
}
`)

  write('src/main/java/com/example/app/Wild.java', `
package com.example.app;
import com.example.util.*;
public class Wild {
  public int viaStar() { return Helper.doubleIt(2); }
}
`)

  write('src/main/java/com/example/app/Stat.java', `
package com.example.app;
import static com.example.util.Helper.doubleIt;
public class Stat {
  public int viaStatic() { return doubleIt(3); }
}
`)

  write('src/test/java/com/example/service/ServiceTest.java', `
package com.example.service;
class ServiceTest {
  void runs() {
    new Service().run(1);
  }
}
`)

  db = await fixture.build()
})

after(() => fixture.cleanup())


describe('Java query extract', () => {
  it('indexes every Java source file', () => {
    const files = one("SELECT COUNT(*) c FROM files WHERE lang='java'").c
    assert.equal(files, 9)
  })

  it('extracts types and methods', () => {
    assert.ok(one("SELECT qname FROM nodes WHERE name='Service' AND kind='class'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='Runnable' AND kind='interface'"))
    assert.ok(one("SELECT qname FROM nodes WHERE name='run' AND kind='method' AND path LIKE '%Service.java'"))
    assert.equal(one("SELECT exported e FROM nodes WHERE name='bump' AND kind='method'").e, 0)
    assert.equal(one("SELECT exported e FROM nodes WHERE name='run' AND kind='method' AND path LIKE '%Service.java'").e, 1)
  })

  it('resolves FQCN imports', () => {
    const row = one(
      "SELECT resolved_path r FROM imports WHERE path LIKE '%Service.java' AND spec='com.example.util.Helper'",
    )
    assert.equal(row.r, 'src/main/java/com/example/util/Helper.java')
  })

  it('creates file-level IMPORTS edges', () => {
    const edge = one(`
      SELECT COUNT(*) c FROM edges
      WHERE kind='IMPORTS'
        AND src='src/main/java/com/example/service/Service.java'
        AND dst='src/main/java/com/example/util/Helper.java'
    `)
    assert.equal(edge.c, 1)
  })
})

describe('Java call resolution', () => {
  it('resolves Helper.doubleIt through a named import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%Helper.doubleIt'
    `)
    assert.ok(edge, 'Service.run -> Helper.doubleIt')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves this.method() on the class', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%Service.bump'
    `)
    assert.ok(edge, 'this.bump()')
    assert.equal(edge.confidence, 0.8)
  })

  it('resolves this.method() on an inherited member', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%Base.init'
    `)
    assert.ok(edge, 'this.init() follows INHERITS')
    assert.equal(edge.confidence, 0.8)
  })

  it('resolves a same-package type without an import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Service.run'
        AND dst LIKE '%SamePkg.ping'
    `)
    assert.ok(edge, 'SamePkg.ping is visible in-package')
    assert.equal(edge.resolved, 1)
    assert.equal(edge.confidence, 1)
  })

  it('resolves new Type() on an imported class', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Main.main'
        AND dst LIKE '%Service.java::Service'
    `)
    assert.ok(edge, 'new Service()')
    assert.equal(edge.confidence, 1)
  })

  it('resolves a wildcard import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Wild.viaStar'
        AND dst LIKE '%Helper.doubleIt'
    `)
    assert.ok(edge, 'import com.example.util.* exposes Helper')
    assert.equal(edge.confidence, 1)
  })

  it('resolves a static import', () => {
    const edge = one(`
      SELECT * FROM edges
      WHERE kind='CALLS'
        AND src LIKE '%Stat.viaStatic'
        AND dst LIKE '%Helper.doubleIt'
    `)
    assert.ok(edge, 'import static Helper.doubleIt; doubleIt()')
    assert.equal(edge.confidence, 1)
  })

  it('records inheritance and interfaces', () => {
    const inherits = one("SELECT * FROM edges WHERE kind='INHERITS' AND src LIKE '%Service.java::Service'")
    assert.ok(inherits.dst.includes('Base'))
    assert.equal(inherits.resolved, 1)

    const impl = one("SELECT * FROM edges WHERE kind='IMPLEMENTS' AND src LIKE '%Service.java::Service'")
    assert.ok(impl.dst.includes('Runnable'))
    assert.equal(impl.resolved, 1)
  })

  it('never fabricates an edge for an unknown target', () => {
    const bogus = all("SELECT * FROM edges WHERE resolved=1 AND dst NOT IN (SELECT qname FROM nodes)")
    assert.equal(bogus.length, 0)
  })
})

describe('Java tests and query tools', () => {
  it('marks JUnit-style test files', () => {
    assert.equal(
      one("SELECT is_test t FROM nodes WHERE path LIKE '%ServiceTest.java' AND kind='file'").t,
      1,
    )
  })

  it('finds a Java method by name', () => {
    const r = findSymbols(db, { query: 'doubleIt', budget: 1500 })
    const hit = r.rows.find((h) => h.name === 'doubleIt')
    assert.ok(hit)
    assert.match(hit.path, /Helper\.java$/)
    assert.equal(hit.kind, 'method')
  })

  it('lists java in overview languages', () => {
    const o = overview(db, undefined, 1500)
    assert.ok(o.languages.some((l) => l.lang === 'java'))
    assert.equal(o.totals.files, 9)
  })

  it('never reports an FTS hit the node does not contain', () => {
    assertFtsConsistent(db, 'java fixture')
  })
})

/**
 * B2: `path::Class.method` carries no arity, so overloads collide on the
 * `nodes` primary key. The overloads are deliberately non-adjacent — an
 * adjacent pair happens to write its duplicate tokens at the right rowid and
 * hides the defect.
 */
describe('Java method overloads', () => {
  const ov = createFixture('cg-java-overload-')
  let ovDb

  before(async () => {
    ov.write(
      'src/Widget.java',
      `package src;

public class Widget {
    public void render(String s) { }
    public void helperAlphaOnly() { }
    public void render(int n) { }
}
`,
    )
    ovDb = await ov.build()
  })

  after(() => ov.cleanup())

  const renders = () =>
    ovDb.db.prepare("SELECT qname, signature FROM nodes WHERE name='render' ORDER BY line_start").all()

  it('keeps every overload as its own node', () => {
    const rows = renders()
    assert.equal(rows.length, 2, 'both render overloads survive')
    assert.deepEqual(rows.map((r) => r.signature), ['render(String s)', 'render(int n)'])
    // The first overload keeps the bare qname `this.render()` resolves to.
    assert.equal(rows[0].qname, 'src/Widget.java::Widget.render')
    assert.notEqual(rows[1].qname, rows[0].qname)
  })

  it('fabricates no search hit for an unrelated symbol', () => {
    assertFtsConsistent(ovDb, 'java overloads')
    const hits = findSymbols(ovDb, { query: 'render', budget: 1500 }).rows
    assert.equal(hits.some((h) => h.name === 'helperAlphaOnly'), false, 'phantom hit')
    assert.equal(hits.filter((h) => h.name === 'render').length, 2)
  })

  it('stays consistent after re-indexing the file', async () => {
    ov.write(
      'src/Widget.java',
      `package src;

public class Widget {
    public void render(String s) { }
    public void helperAlphaOnly() { }
    public void render(int n) { }
    public void render(long l) { }
}
`,
    )
    await incrementalBuild(ovDb, ov.root, ['src/Widget.java'])
    assert.equal(renders().length, 3)
    assertFtsConsistent(ovDb, 'java overloads after edit')
    assert.ok(
      findSymbols(ovDb, { query: 'helperAlphaOnly', budget: 1500 }).rows
        .some((h) => h.name === 'helperAlphaOnly'),
      'helperAlphaOnly still findable',
    )
  })
})

// ---------------------------------------------------------------------------
// a type's signature must name the type, not quote its body.
// ---------------------------------------------------------------------------

describe('Java type signatures', () => {
  const typeRows = () =>
    db.db.prepare("SELECT name, kind, signature FROM nodes WHERE kind IN ('class','interface','enum')").all()

  it('composes the signature instead of falling back to the body', () => {
    const rows = typeRows()
    assert.ok(rows.length >= 5, 'the fixture really has types')
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.signature]))
    assert.equal(byName.Service, 'class Service')
    assert.equal(byName.Runnable, 'interface Runnable')
    for (const r of rows) {
      assert.equal(r.signature.includes('{'), false, `${r.name} quotes its body: ${r.signature}`)
      assert.ok(r.signature.length <= 60, `${r.name} signature is compact`)
    }
  })

  it('keeps a method name out of its enclosing type\'s search text', () => {
    // `Service.run` lives in Service's body; with the body as signature it was
    // indexed into Service's FTS entry, so searching a method found its class.
    const hits = findSymbols(db, { query: 'bump', budget: 1500 }).rows
    assert.ok(hits.some((h) => h.name === 'bump'), 'the method itself is found')
    assert.equal(hits.some((h) => h.name === 'Service'), false, 'the class is not a hit')
  })
})
