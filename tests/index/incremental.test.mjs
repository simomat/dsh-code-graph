/**
 * Incremental freshness: what a rebuild does after the repository moves.
 *
 * The index learns about edits two ways — the agent reports the file it just
 * wrote, and `git status` reports everything else — and every group here pins
 * down one way those two can disagree: an edit git has not seen, a commit the
 * agent never touched, a file reported twice, a file deleted out from under
 * both. Each group gets its own repository and manager so none can observe
 * another's index.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { incrementalBuild } from '../../src/index/build.ts'
import { findSymbols } from '../../src/query/find.ts'
import { clearResolverConfigCache, resolverConfigFor } from '../../src/parse/imports/config.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { execLike, acquireOnce } from '../helpers/manager.mjs'
import { createRepo } from '../helpers/repo.mjs'

let repo
let root

const write = (rel, text) => repo.write(rel, text)
const git = (args) => repo.git(args)

/** A committed repository and a manager over it, fresh for one test group. */
async function setupFixture(prefix = 'cg-incremental-') {
  repo = await createRepo(prefix)
  root = repo.root
  return repo.manager
}

const teardownFixture = () => repo.cleanup()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('incrementalBuild', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('builds the initial index', async () => {
    const db = await acquireOnce(mgr, exec)
    assert.ok(db, 'database ready')
    const rows = db.db.prepare("SELECT COUNT(*) c FROM nodes WHERE kind='file'").all()
    const count = rows[0].c
    assert.ok(count >= 3, `initial build indexed ${count} files`)
  })

  it('detects a dirty file and rebuilds', async () => {
    // Modify src/util.ts
    write('src/util.ts', `
export function helper(x: number): number { return x * 3 }
export const CONST = 99
export function newFunction(): string { return "hello" }
`)

    // Mark it dirty (simulating the fs/observed event).
    mgr.markDirty(repo.path('src/util.ts'))

    // Query — should trigger incremental rebuild.
    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    assert.ok(result.freshness.rebuiltFiles >= 1, `rebuilt at least 1 file, got ${result.freshness.rebuiltFiles}`)

    // Verify the index reflects the change by checking newFunction exists.
    const newFn = result.db.db.prepare(
      "SELECT qname FROM nodes WHERE name='newFunction' AND kind='function'",
    ).get()
    assert.ok(newFn, 'newFunction exists after rebuild')

    // Verify util.ts node count matches the modified file (4 symbols + file = 5... wait, 3 symbols + file = 4).
    // The modified file has: file, helper, CONST, newFunction = 4 nodes.
    const count = result.db.db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE path='src/util.ts'",
    ).get().c
    assert.equal(count, 4, `util.ts has 4 nodes after rebuild (file + helper + CONST + newFunction)`)
  })

  it('picks up new files from the working tree', async () => {
    // Write a new file (not yet staged — gitDirtyPaths will detect it).
    write('src/newfile.ts', `
export function brandNew(): number { return 42 }
`)

    // The file is untracked; gitDirtyPaths picks it up.
    // Mark dirty so incremental rebuild triggers.
    mgr.markDirty(repo.path('src/newfile.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')

    const found = findSymbols(result.db, { query: 'brandNew', budget: 1500 })
    assert.ok(found.total >= 1, 'new symbol found after incremental rebuild')
  })

  it('purges deleted files from the index', async () => {
    // First, commit newfile so it's tracked.
    await git(['add', 'src/newfile.ts'])
    await git(['commit', '-m', 'add newfile'])

    // Verify the file is in the index (file node + brandNew symbol = 2 nodes).
    const db = await acquireOnce(mgr, exec)
    const before = db.db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE path='src/newfile.ts'",
    ).get()
    assert.ok(before.c >= 2, 'newfile is in the index before deletion')

    // Delete the file.
    repo.remove('src/newfile.ts')

    // Commit the deletion.
    await git(['add', '-A'])
    await git(['commit', '-m', 'delete newfile'])

    // Mark something dirty to trigger the rebuild.
    mgr.markDirty(repo.path('src/util.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    assert.ok(result.freshness.rebuiltDeleted >= 1, `deleted at least 1 file, got ${result.freshness.rebuiltDeleted}`)

    const after = result.db.db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE path='src/newfile.ts'",
    ).get()
    assert.equal(after.c, 0, 'newfile purged from index after deletion')
  })

  it('handles multiple dirty files in one pass', async () => {
    write('src/util.ts', `
export function helper(x: number): number { return x * 4 }
export const CONST = 999
export function newFunction(): string { return "world" }
export function anotherOne(): void {}
`)
    write('src/service.ts', `
import { helper } from './util'

export class Service {
  run(n: number): number {
    return helper(n)
  }
  extra(): void {}
}
`)

    mgr.markDirty(repo.path('src/util.ts'))
    mgr.markDirty(repo.path('src/service.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    assert.ok(result.freshness.rebuiltFiles >= 2, `rebuilt both dirty files, got ${result.freshness.rebuiltFiles}`)
  })

  it('reports freshness fields after rebuild', async () => {
    // Mark a file dirty to force a rebuild on the next acquire.
    write('src/util.ts', `
export function helper(x: number): number { return x * 5 }
export const CONST = 111
export function newFunction(): string { return "test" }
export function anotherOne(): void {}
`)
    mgr.markDirty(repo.path('src/util.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    assert.ok(result.freshness.builtAt !== null, 'builtAt is set')
    assert.ok(result.freshness.rebuiltFiles !== undefined, 'rebuiltFiles present after rebuild')
    assert.ok(result.freshness.dirtyFiles === 0, 'dirtyFiles cleared after rebuild')
  })

  it('returns ready on a clean query (no rebuild needed)', async () => {
    // Earlier tests in this suite leave uncommitted edits. Drain them so this
    // assertion measures a truly clean worktree, not a skipped git-status check.
    await git(['add', '-A'])
    try {
      await git(['commit', '-m', 'drain leftover edits'])
    } catch {
      // Working tree already matched HEAD.
    }
    await mgr.acquire(exec)
    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    assert.equal(result.freshness.dirtyFiles, 0)
    assert.equal(result.freshness.rebuiltFiles, undefined, 'no rebuild field when nothing changed')
  })
})

describe('incrementalBuild — no-op rebuild', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('rebuilds only dirty files, not the whole repo', async () => {
    const db = await acquireOnce(mgr, exec)
    const beforeFiles = db.db.prepare("SELECT COUNT(*) c FROM nodes WHERE kind='file'").get().c

    // Modify one file.
    write('src/util.ts', `
export function helper(x: number): number { return x * 100 }
export const CONST = 1
`)
    mgr.markDirty(repo.path('src/util.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')

    const afterFiles = result.db.db.prepare("SELECT COUNT(*) c FROM nodes WHERE kind='file'").get().c
    assert.equal(afterFiles, beforeFiles, 'file count unchanged — only content rebuilt')
  })

  it('handles a parse error gracefully', async () => {
    // Write a file with broken TypeScript.
    write('src/broken.ts', `
export function broken( { this is not valid TS
`)

    mgr.markDirty(repo.path('src/broken.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready', 'rebuild succeeds even with parse errors')

    const fileRow = result.db.db.prepare(
      "SELECT parse_error FROM files WHERE path='src/broken.ts'",
    ).get()
    assert.ok(fileRow, 'broken file is still indexed')
  })
})

describe('HEAD change detection', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('detects a HEAD change and rebuilds', async () => {
    const db = await acquireOnce(mgr, exec)
    const storedHead = db.getMeta('head_commit')
    assert.ok(storedHead, 'head_commit stored')

    // Make a commit to change HEAD.
    write('src/util.ts', `
export function helper(x: number): number { return x * 200 }
export const CONST = 777
`)
    await git(['add', 'src/util.ts'])
    await git(['commit', '-m', 'change for head'])

    // Mark dirty so we trigger the rebuild path.
    mgr.markDirty(repo.path('src/util.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    const newHead = db.getMeta('head_commit')
    assert.notEqual(newHead, storedHead, 'head_commit updated')
  })
})

describe('incrementalBuild — deleted file via standalone API', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('removes a deleted file from the index', async () => {
    const db = await acquireOnce(mgr, exec)
    const before = db.db.prepare("SELECT COUNT(*) c FROM nodes WHERE path='src/service.ts'").get().c
    assert.ok(before >= 2, 'service.ts in index (file + symbols)')

    // Delete the file and commit.
    repo.remove('src/service.ts')
    await git(['add', '-A'])
    await git(['commit', '-m', 'delete service'])

    // Mark something dirty to trigger rebuild.
    mgr.markDirty(repo.path('src/util.ts'))

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    assert.ok(result.freshness.rebuiltDeleted >= 1, 'deleted file detected')

    const after = result.db.db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE path='src/service.ts'",
    ).get()
    assert.equal(after.c, 0, 'service.ts purged from index')
  })
})

describe('HEAD-only change', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('rebuilds overlapping files when HEAD changed with a clean worktree', async () => {
    const db = await acquireOnce(mgr, exec)
    const storedHead = db.getMeta('head_commit')
    assert.ok(storedHead, 'head_commit stored')

    write('src/util.ts', `
export function helper(x: number): number { return x * 300 }
export const CONST = 888
export function afterHeadChange(): number { return 1 }
`)
    await git(['add', 'src/util.ts'])
    await git(['commit', '-m', 'HEAD-only change'])

    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    const newHead = db.getMeta('head_commit')
    assert.notEqual(newHead, storedHead, 'head_commit updated after HEAD-only change')
    assert.ok(result.freshness.rebuiltFiles >= 1, `rebuilt files due to HEAD change, got ${result.freshness.rebuiltFiles}`)

    const added = result.db.db.prepare(
      "SELECT qname FROM nodes WHERE name='afterHeadChange' AND kind='function'",
    ).get()
    assert.ok(added, 'committed overlapping-file change is in the index without markDirty')
  })
})

describe('dedup — file in both agent dirty and git dirty', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('indexes a file only once when both dirty sources agree', async () => {
    // Establish baseline index first.
    await acquireOnce(mgr, exec)

    // Modify a file AND mark it dirty via the agent — the file appears in both sets.
    write('src/util.ts', `
export function helper(x: number): number { return x * 500 }
export const CONST = 999
export function dedupTest(): void {}
`)

    // Stage the change so gitDirtyPaths reliably detects it as a working-tree modification.
    await git(['add', 'src/util.ts'])

    // Mark dirty via agent (simulating fs/observed event).
    mgr.markDirty(repo.path('src/util.ts'))

    // gitDirtyPaths will also detect it as a working-tree modification.
    // The delta should deduplicate, so util.ts is indexed exactly once.
    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')

    // Count nodes in util.ts — should be exactly 4 (file + helper + CONST + dedupTest).
    const count = result.db.db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE path='src/util.ts'",
    ).get().c
    assert.equal(count, 4, `util.ts has exactly 4 nodes (no duplication), got ${count}`)
    assert.equal(result.freshness.rebuiltFiles, 1, `rebuilt exactly 1 file, got ${result.freshness.rebuiltFiles}`)
  })
})

describe('out-of-band git status without markDirty', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('picks up an uncommitted edit via git status', async () => {
    await acquireOnce(mgr, exec)
    write('src/util.ts', `
export function helper(x: number): number { return x * 2 }
export const CONST = 42
export function afterOobEdit(): void {}
`)
    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    const added = result.db.db.prepare(
      "SELECT qname FROM nodes WHERE name='afterOobEdit' AND kind='function'",
    ).get()
    assert.ok(added, 'uncommitted edit visible without markDirty')
  })

  it('purges a worktree deletion via git status', async () => {
    repo.remove('src/service.ts')
    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    const after = result.db.db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE path='src/service.ts'",
    ).get()
    assert.equal(after.c, 0, 'deleted file purged without markDirty')
  })
})

describe('incremental re-resolves unchanged callers', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('resolves a unique name in an unchanged file after a new definition appears', async () => {
    write('src/caller.ts', `
export function callsLater(): number { return uniqueLater() }
`)
    mgr.markDirty(repo.path('src/caller.ts'))
    const db = await acquireOnce(mgr, exec)
    const before = db.db.prepare(
      "SELECT resolved, dst FROM edges WHERE kind='CALLS' AND src='src/caller.ts::callsLater' AND dst LIKE '%uniqueLater%'",
    ).get()
    assert.ok(before, 'unresolved call recorded')
    assert.equal(before.resolved, 0)

    write('src/later.ts', `
export function uniqueLater(): number { return 7 }
`)
    mgr.markDirty(repo.path('src/later.ts'))
    const result = await mgr.acquire(exec)
    assert.equal(result.status, 'ready')
    const after = result.db.db.prepare(
      "SELECT resolved, dst, confidence FROM edges WHERE kind='CALLS' AND src='src/caller.ts::callsLater' AND dst='src/later.ts::uniqueLater'",
    ).get()
    assert.ok(after, 'unchanged caller re-resolved against the new export')
    assert.equal(after.resolved, 1)
  })
})

// ---------------------------------------------------------------------------
// the resolver config is reused until one of its inputs moves.
//
// Building it reads every .java/.go/.rs file in the repository. Doing that
// again for a one-file edit cost more than the incremental re-index it was
// preparing for. The cache is only sound if every input that can change it
// invalidates it, which is what these cases pin down: the config-relevant file
// universe, an edited config source, and an edited manifest — the last one
// never reaches the caller's `changed` set, since manifests are not indexed.
// ---------------------------------------------------------------------------

describe('resolver config cache', () => {
  const cfg = createFixture('cg-m9-')
  const cfgRoot = cfg.root
  let listing

  before(() => {
    const w = cfg.write
    w('go.mod', 'module example.com/app\n\ngo 1.22\n')
    w('tsconfig.json', '{ "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }\n')
    w('src/App.java', 'package src;\n\npublic class App { public void run() { } }\n')
    w('src/main.go', 'package main\n\nfunc Run() {}\n')
    w('src/a.ts', 'export const a = 1\n')
    listing = ['go.mod', 'tsconfig.json', 'src/App.java', 'src/main.go', 'src/a.ts']
    clearResolverConfigCache()
  })

  after(() => {
    clearResolverConfigCache()
    cfg.cleanup()
  })

  /** Rebuild unconditionally and return the freshly cached config. */
  const rebuild = () => resolverConfigFor(cfgRoot, listing)

  it('rebuilds unconditionally when no changed set is given', () => {
    const first = rebuild()
    const second = rebuild()
    assert.notEqual(second, first, 'a full build never serves a stale config')
  })

  it('reuses the cached config when nothing it depends on changed', () => {
    const base = rebuild()
    const reused = resolverConfigFor(cfgRoot, listing, new Set(['src/a.ts', 'README.md']))
    assert.equal(reused, base, 'a TypeScript edit does not touch any config input')
  })

  it('rebuilds when a config source file changed', () => {
    const base = rebuild()
    for (const changed of ['src/App.java', 'src/main.go', 'src/lib.rs', 'go.mod']) {
      assert.notEqual(
        resolverConfigFor(cfgRoot, listing, new Set([changed])),
        base,
        `${changed} is a config input`,
      )
      rebuild()
    }
  })

  it('rebuilds when the file universe gains or loses a config input', () => {
    const base = rebuild()
    const added = resolverConfigFor(cfgRoot, [...listing, 'src/Other.java'], new Set())
    assert.notEqual(added, base, 'a new .java file changes what the config indexes')

    const shrunk = rebuild()
    const removed = resolverConfigFor(cfgRoot, listing.filter((f) => f !== 'src/main.go'), new Set())
    assert.notEqual(removed, shrunk)
  })

  it('rebuilds when a manifest is edited without appearing in the changed set', () => {
    const base = rebuild()
    cfg.write('go.mod', 'module example.com/renamed-app\n\ngo 1.22\n')
    const next = resolverConfigFor(cfgRoot, listing, new Set())
    assert.notEqual(next, base, 'manifests are stat-checked; they are never indexed')
  })

  it('keeps the alias list sorted longest-prefix-first', () => {
    const config = rebuild()
    const lengths = config.aliases.map((r) => r.prefix.length)
    assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a))
  })
})

// ---------------------------------------------------------------------------
// the cache must not hide a new declaration from the next incremental.
// ---------------------------------------------------------------------------

describe('incremental picks up a new Java type through the cached config', () => {
  const fixture = createFixture('cg-m9-java-')
  const { root, write } = fixture
  const dbHome = createFixture('cg-m9-java-db-')
  let db

  before(async () => {
    write('src/core/Helper.java', 'package core;\n\npublic class Helper { public static void go() { } }\n')
    write(
      'src/app/Main.java',
      'package app;\n\nimport core.Helper;\n\npublic class Main { public void run() { Helper.go(); } }\n',
    )
    clearResolverConfigCache()
    db = await fixture.build(dbHome.path('graph.db'))
  })

  after(() => {
    clearResolverConfigCache()
    fixture.cleanup()
    dbHome.cleanup()
  })

  const importsOf = (path) =>
    db.db
      .prepare('SELECT spec, resolved_path FROM imports WHERE path = ? AND resolved_path IS NOT NULL')
      .all(path)
      .map((r) => `${r.spec} -> ${r.resolved_path}`)

  it('resolves the initial import', () => {
    assert.ok(
      importsOf('src/app/Main.java').includes('core.Helper -> src/core/Helper.java'),
      'baseline resolution',
    )
  })

  it('resolves a type added after the config was cached', async () => {
    write('src/core/Other.java', 'package core;\n\npublic class Other { public static void go() { } }\n')
    write(
      'src/app/Main.java',
      'package app;\n\nimport core.Other;\n\npublic class Main { public void run() { Other.go(); } }\n',
    )

    const result = await incrementalBuild(db, root, [])
    assert.ok(result.filesIndexed >= 2, 'both files re-indexed')
    assert.ok(
      importsOf('src/app/Main.java').includes('core.Other -> src/core/Other.java'),
      'the new FQCN is in the config the incremental used',
    )
  })
})
