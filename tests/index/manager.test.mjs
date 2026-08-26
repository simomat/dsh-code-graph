/**
 * The IndexManager: who owns a build, and how long it lives.
 *
 * A tool call asks for a graph and gets one back, or gets told why not. The
 * cases that matter are the ones where two things want the same graph at once,
 * where opening it failed last time, and where the call that started a build
 * goes away before the build does.
 */
import assert from 'node:assert/strict'
import { symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { GraphDb, graphDbPath } from '../../src/db.ts'
import { canonicalizeRepoRoot } from '../../src/repo.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { execLike, acquireOnce, makeManager } from '../helpers/manager.mjs'
import { createRepo } from '../helpers/repo.mjs'

let repo
let root

const write = (rel, text) => repo.write(rel, text)

/** A committed repository and a manager over it, fresh for one test group. */
async function setupFixture(prefix = 'cg-manager-') {
  repo = await createRepo(prefix)
  root = repo.root
  return repo.manager
}

const teardownFixture = () => repo.cleanup()

describe('failed build retries on next acquire', () => {
  it('does not stay unavailable after a transient open failure', async () => {
    await setupFixture()
    repo.disposeManager()
    const exec = execLike(root)
    let opens = 0
    const retry = makeManager({
      open: (path, repoRoot) => {
        opens += 1
        if (opens === 1) throw new Error('simulated open failure')
        return GraphDb.open(path, repoRoot)
      },
    })
    const first = await retry.manager.acquire(exec)
    assert.equal(first.status, 'not-ready', 'first call reports the failure')
    const second = await retry.manager.acquire(exec)
    assert.equal(second.status, 'ready', 'second call retries and succeeds')
    retry.dispose()
    repo.cleanup()
  })
})

describe('parallel acquire is serialized', () => {
  let mgr
  let exec

  before(async () => {
    mgr = await setupFixture()
    exec = execLike(root)
  })

  after(teardownFixture)

  it('two overlapping acquires both finish ready', async () => {
    await acquireOnce(mgr, exec)
    write('src/util.ts', `
export function helper(x: number): number { return x * 9 }
export const CONST = 1
`)
    mgr.markDirty(repo.path('src/util.ts'))
    const [a, b] = await Promise.all([mgr.acquire(exec), mgr.acquire(exec)])
    assert.equal(a.status, 'ready')
    assert.equal(b.status, 'ready')
  })
})

// ---------------------------------------------------------------------------
// a background build outlives the call that started it.
//
// `startBuild` used to run on the first caller's AbortSignal. When that call
// aborted, the build died without setting `entry.error`, so the next acquire
// found neither `db` nor `building` and started over — a repository too large
// to finish inside the 1500 ms grace could never become ready. The build now
// runs on a manager-owned controller that only `dispose()` fires.
//
// The fixture is sized so the build outlasts the abort, not so it outlasts the
// grace period: the restart is what is under test, and it happens either way.
// ---------------------------------------------------------------------------

describe('build lifetime is independent of the caller', () => {
  const FILES = 3000
  const build = createFixture('cg-m5-build-')
  const buildRoot = build.root

  const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })

  before(() => {
    for (let i = 0; i < FILES; i += 1) {
      build.write(`src/f${i}.ts`, `export function f${i}(): number { return ${i} }\n`)
    }
  })

  after(() => build.cleanup())

  function countingManager(onOpen = () => {}) {
    const stats = { opens: 0, closes: 0 }
    const managed = makeManager({
      open: (path, repoRoot) => {
        stats.opens += 1
        const db = GraphDb.open(path, repoRoot)
        const close = db.close.bind(db)
        db.close = () => { stats.closes += 1; close() }
        onOpen(db)
        return db
      },
    })
    return { mgr: managed.manager, stats, removeDb: managed.removeDb }
  }

  it('an aborted call does not restart the build', async () => {
    const { mgr, stats, removeDb } = countingManager()
    const exec = execLike(buildRoot)

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 60).unref?.()
    await assert.rejects(
      () => mgr.acquire(exec, { signal: ac.signal }),
      (err) => err instanceof Error && err.name === 'AbortError',
      'the aborted call abandons its wait',
    )
    assert.equal(stats.opens, 1, 'exactly one build was started')

    // Retry the way the model would after a `building` reply.
    let handle
    for (let i = 0; i < 5; i += 1) {
      handle = await mgr.acquire(exec)
      if (handle.status === 'ready') break
    }
    assert.equal(handle.status, 'ready', 'the abandoned build still converges')
    assert.equal(stats.opens, 1, 'the build was resumed, not restarted from scratch')

    mgr.dispose()
    removeDb()
  })

  it('dispose aborts an in-flight build and closes its database', async () => {
    const { mgr, stats, removeDb } = countingManager()
    const exec = execLike(buildRoot)

    const pending = mgr.acquire(exec)
    await delay(40)
    assert.equal(stats.opens, 1, 'the build is in flight')
    mgr.dispose()

    const handle = await pending
    assert.equal(handle.status, 'not-ready', 'a disposed manager hands out no database')
    assert.equal(stats.closes, 1, 'the in-flight build closed the database it opened')

    removeDb()
  })
})

describe('repo identity', () => {
  it('trailing slash and symlink hash to the same db path', () => {
    const fx = createFixture('cg-real-')
    const real = fx.root
    const link = `${real}-link`
    try {
      symlinkSync(real, link)
      const home = join(tmpdir(), 'cg-dsh-home')
      assert.equal(canonicalizeRepoRoot(`${real}/`), canonicalizeRepoRoot(real))
      assert.equal(canonicalizeRepoRoot(link), canonicalizeRepoRoot(real))
      assert.equal(graphDbPath(home, `${real}/`), graphDbPath(home, real))
      assert.equal(graphDbPath(home, link), graphDbPath(home, real))
    } finally {
      rmSync(link, { force: true })
      fx.cleanup()
    }
  })

  it('manager reuses one entry for trailing-slash cwd', async () => {
    const fx = createFixture('cg-slash-')
    const opened = []
    fx.write('src/a.ts', 'export const a = 1\n')
    const { manager, dispose } = makeManager({
      open: (dbPath, repoRoot) => {
        opened.push(repoRoot)
        return GraphDb.open(dbPath, repoRoot)
      },
    })
    try {
      const first = await manager.acquire(execLike(fx.root))
      assert.equal(first.status, 'ready')
      const second = await manager.acquire(execLike(`${fx.root}/`))
      assert.equal(second.status, 'ready')
      assert.equal(opened.length, 1, 'open once for slash variants')
    } finally {
      dispose()
      fx.cleanup()
    }
  })
})

describe('AbortSignal', () => {
  it('acquire throws when already aborted', async () => {
    const fx = createFixture('cg-abort-')
    fx.write('src/a.ts', 'export const a = 1\n')
    const { manager, dispose } = makeManager()
    try {
      const ac = new AbortController()
      ac.abort()
      await assert.rejects(
        () => manager.acquire(execLike(fx.root), { signal: ac.signal }),
        (err) => err instanceof Error && err.name === 'AbortError',
      )
    } finally {
      dispose()
      fx.cleanup()
    }
  })
})
