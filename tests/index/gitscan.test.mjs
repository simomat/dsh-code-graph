/**
 * Reading the repository's file list, and what happens when git stops answering.
 *
 * `listFiles` prefers git and falls back to a directory walk on any failure —
 * a missing binary, an index lock, a timeout. The walk cannot see everything
 * git can, so the fallback must never be read as "these files are gone".
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { incrementalBuild } from '../../src/index/build.ts'
import { parsePorcelainZ } from '../../src/index/gitscan.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { git as runGit, initRepo } from '../helpers/git.mjs'

describe('git porcelain', () => {
  it('keeps both paths of a -z rename record', () => {
    const out = 'R  src/old.ts\0src/new.ts\0?? untracked.ts\0'
    assert.deepEqual(parsePorcelainZ(out), ['src/old.ts', 'src/new.ts', 'untracked.ts'])
  })
})

// ---------------------------------------------------------------------------
// git going unavailable must not purge files the fallback walk cannot see.
//
// `listFiles` falls back to a directory walk on any git failure (20s timeout,
// missing binary, index lock). The walk skips IGNORED_DIRS and dot-directories,
// so files git tracks there are absent from its listing — and were classified
// deleted. The fixture puts a file in each blind spot.
// ---------------------------------------------------------------------------

describe('git transitioning to unavailable', () => {
  const fixture = createFixture('cg-b1-fixture-')
  const { root, write } = fixture
  const git = (args) => runGit(root, args)
  const dbHome = createFixture('cg-b1-db-')
  let db

  const indexedPaths = () =>
    db.db.prepare('SELECT path FROM files ORDER BY path').all().map((r) => r.path)

  /** Run `fn` with git unresolvable on PATH. */
  async function withoutGit(fn) {
    const saved = process.env.PATH
    process.env.PATH = fixture.path('__no_git__')
    try {
      return await fn()
    } finally {
      process.env.PATH = saved
    }
  }

  before(async () => {
    write('src/a.ts', 'export function a(): number { return 1 }\n')
    // Tracked by git, invisible to walkDir: 'build' is in IGNORED_DIRS.
    write('build/gen.ts', 'export function gen(): number { return 2 }\n')
    // Tracked by git, invisible to walkDir: dot-directories are skipped.
    write('.config/conf.ts', 'export const conf = 3\n')
    await initRepo(root, { force: true })

    db = await fixture.build(dbHome.path('graph.db'))
  })

  after(() => {
    fixture.cleanup()
    dbHome.cleanup()
  })

  it('keeps every file that still exists on disk', async () => {
    const before = indexedPaths()
    assert.deepEqual(before, ['.config/conf.ts', 'build/gen.ts', 'src/a.ts'])

    const result = await withoutGit(() => incrementalBuild(db, root, []))

    assert.equal(result.filesDeleted, 0, 'nothing purged while git was unavailable')
    assert.deepEqual(indexedPaths(), before, 'index unchanged')
    assert.equal(db.getMeta('file_source'), 'git', 'recorded source never downgrades to walk')
  })

  it('still purges a file genuinely removed from disk', async () => {
    fixture.remove('src/a.ts')

    const result = await withoutGit(() => incrementalBuild(db, root, []))

    assert.equal(result.filesDeleted, 1, 'on-disk absence is ground truth regardless of git')
    assert.deepEqual(indexedPaths(), ['.config/conf.ts', 'build/gen.ts'])
  })

  it('resumes listing-driven purges once git is back', async () => {
    fixture.remove('build/gen.ts')
    await git(['add', '-A'])
    await git(['commit', '-m', 'drop gen'])

    const result = await incrementalBuild(db, root, [])

    assert.equal(result.filesDeleted, 1)
    assert.deepEqual(indexedPaths(), ['.config/conf.ts'])
  })
})
