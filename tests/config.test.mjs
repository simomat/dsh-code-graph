/**
 * User configuration: what a settings section changes about the index.
 *
 * The interesting cases are the ones where a value the user typed has to reach
 * a decision buried in the build, so each test asserts the observable effect
 * (what ends up indexed) rather than that a field was plumbed somewhere.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { GraphDb } from '../src/db.ts'
import { fullBuild, indexLimits, DEFAULT_INDEX_LIMITS } from '../src/index/build.ts'
import { excludeMatcher, listFiles } from '../src/index/gitscan.ts'
import { langFilter } from '../src/parse/loader.ts'
import { clampBudget } from '../src/query/budget.ts'
import { overview } from '../src/query/overview.ts'
import { findSymbols } from '../src/query/find.ts'
import { cardMeta } from '../src/tools/present.ts'
import { assertServiceableConfig, invalidatesIndex } from '../src/config.ts'
import { CodeGraphConfigSchema } from '../src/settings.ts'
import { createFixture } from './helpers/fixture.mjs'
import { gitAvailable, initRepo } from './helpers/git.mjs'

/** A resolved section with every default filled in, plus the given overrides. */
function config(overrides = {}) {
  return CodeGraphConfigSchema({ ...overrides })
}

const fixture = createFixture('cg-config-')
const { root, write } = fixture

// Probed at module scope on purpose: the `skip` option below is read when the
// `describe` body runs, which is not ordered after an async `before` hook.
/** Whether git ran here; the git-backed enumeration test is skipped without it. */
const hasGit = gitAvailable()

before(async () => {
  write('src/app.ts', 'export function app(): number { return 1 }\n')
  write('generated/huge.ts', `export const BIG = '${'x'.repeat(4096)}'\nexport function generated(): number { return 2 }\n`)
  write('vendored/lib/dep.ts', 'export function vendored(): number { return 3 }\n')
  write('src/server.go', 'package main\n\nfunc Serve() int { return 4 }\n')
  if (hasGit) await initRepo(root, { commit: false })
})

after(() => fixture.cleanup())

describe('exclusion patterns', () => {
  it('matches a bare entry against every path segment', () => {
    const excluded = excludeMatcher(['generated'])
    assert.equal(excluded('generated/huge.ts'), true)
    assert.equal(excluded('src/generated/huge.ts'), true)
    assert.equal(excluded('src/app.ts'), false)
  })

  it('anchors an entry containing a slash at the repository root', () => {
    const excluded = excludeMatcher(['vendored/lib'])
    assert.equal(excluded('vendored/lib/dep.ts'), true)
    assert.equal(excluded('src/vendored/lib/dep.ts'), false)
  })

  it('ignores blanks and normalizes leading and trailing slashes', () => {
    const excluded = excludeMatcher(['', '  ', './generated/', 'vendored/lib/'])
    assert.equal(excluded('generated/huge.ts'), true)
    assert.equal(excluded('vendored/lib/dep.ts'), true)
    assert.equal(excluded('src/app.ts'), false)
  })

  it('excludes nothing when configured with nothing', () => {
    assert.equal(excludeMatcher([])('anything/at/all.ts'), false)
    assert.equal(excludeMatcher()('anything/at/all.ts'), false)
  })
})

describe('exclusions reach both enumeration universes', () => {
  it('prunes the directory walk', async () => {
    // A separate fixture: the shared one is a git repository, so `listFiles`
    // would answer from git and never reach the walk this test is about.
    const plain = mkdtempSync(join(tmpdir(), 'cg-walk-'))
    try {
      mkdirSync(join(plain, 'src'), { recursive: true })
      mkdirSync(join(plain, 'generated'), { recursive: true })
      writeFileSync(join(plain, 'src/app.ts'), 'export const a = 1\n')
      writeFileSync(join(plain, 'generated/huge.ts'), 'export const b = 2\n')

      const bare = await listFiles(plain)
      assert.equal(bare.source, 'walk')
      assert.ok(bare.files.includes('generated/huge.ts'), 'the walk lists it without an exclusion')

      const { files, source } = await listFiles(plain, { exclude: ['generated'] })
      assert.equal(source, 'walk')
      assert.ok(files.includes('src/app.ts'))
      assert.equal(files.some((f) => f.startsWith('generated/')), false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('filters the git listing too', { skip: !hasGit }, async () => {
    const bare = await listFiles(root)
    assert.equal(bare.source, 'git', 'fixture is a git repository')
    assert.ok(bare.files.includes('generated/huge.ts'), 'git lists it without an exclusion')

    const { files, source } = await listFiles(root, { exclude: ['generated'] })
    assert.equal(source, 'git')
    assert.ok(files.includes('src/app.ts'))
    assert.equal(files.some((f) => f.startsWith('generated/')), false)
  })
})

describe('language families', () => {
  it('maps a family onto every dialect it covers', () => {
    const only = langFilter(['typescript'])
    assert.equal(only('src/app.ts'), 'typescript')
    assert.equal(only('src/app.tsx'), 'tsx')
    assert.equal(only('src/app.js'), 'javascript')
    assert.equal(only('src/server.go'), undefined)
  })

  it('admits everything when no family list is given', () => {
    assert.equal(langFilter()('src/server.go'), 'go')
  })

  it('keeps a disabled family out of the index', async () => {
    const db = GraphDb.open(':memory:', root)
    try {
      await fullBuild(db, root, undefined, undefined, indexLimits(config({ languages: ['typescript'] })))
      assert.equal(findSymbols(db, { query: 'Serve', budget: 1500 }).rows.length, 0)
      assert.ok(findSymbols(db, { query: 'app', budget: 1500 }).rows.length > 0)
      assert.equal(overview(db, undefined, 1500).languages.some((l) => l.lang === 'go'), false)
    } finally {
      db.close()
    }
  })
})

describe('file size limit', () => {
  it('skips a file above the configured size', async () => {
    const db = GraphDb.open(':memory:', root)
    try {
      await fullBuild(db, root, undefined, undefined, indexLimits(config({ maxFileBytes: 1024 })))
      assert.equal(findSymbols(db, { query: 'generated', budget: 1500 }).rows.length, 0)
      assert.ok(findSymbols(db, { query: 'app', budget: 1500 }).rows.length > 0)
    } finally {
      db.close()
    }
  })

  it('indexes the same file under the default limit', async () => {
    const db = GraphDb.open(':memory:', root)
    try {
      await fullBuild(db, root, undefined, undefined, DEFAULT_INDEX_LIMITS)
      assert.ok(findSymbols(db, { query: 'generated', budget: 1500 }).rows.length > 0)
    } finally {
      db.close()
    }
  })
})

describe('budget bounds', () => {
  it('falls back to the configured default', () => {
    assert.equal(clampBudget(undefined, { defaultBudget: 800, maxBudget: 2000 }), 800)
    assert.equal(clampBudget(Number.NaN, { defaultBudget: 800, maxBudget: 2000 }), 800)
  })

  it('clamps a request to the configured ceiling', () => {
    assert.equal(clampBudget(99_999, { defaultBudget: 800, maxBudget: 2000 }), 2000)
    assert.equal(clampBudget(1, { defaultBudget: 800, maxBudget: 2000 }), 100)
    assert.equal(clampBudget(1200, { defaultBudget: 800, maxBudget: 2000 }), 1200)
  })

  it('uses the built-in bounds when none are supplied', () => {
    assert.equal(clampBudget(undefined), 1500)
    assert.equal(clampBudget(99_999), 6000)
  })
})

describe('section validation', () => {
  it('refuses a default budget above the ceiling', () => {
    assert.throws(() => { assertServiceableConfig(config({ defaultBudget: 5000, maxBudget: 1000 })) },
      /defaultBudget/)
  })

  it('refuses an empty language list', () => {
    assert.throws(() => { assertServiceableConfig(config({ languages: [] })) }, /at least one family/)
  })

  it('accepts the composed defaults', () => {
    assert.doesNotThrow(() => { assertServiceableConfig(config()) })
  })
})

describe('what invalidates a built index', () => {
  it('ignores a budget change', () => {
    assert.equal(invalidatesIndex(config({ defaultBudget: 900 }), config()), false)
  })

  it('notices every field that decides what is indexed', () => {
    const base = config()
    assert.equal(invalidatesIndex(config({ exclude: ['generated'] }), base), true)
    assert.equal(invalidatesIndex(config({ maxFileBytes: 4096 }), base), true)
    assert.equal(invalidatesIndex(config({ languages: ['typescript'] }), base), true)
    assert.equal(invalidatesIndex(config({ indexDir: '/tmp/elsewhere' }), base), true)
  })

  it('treats a reordered language list as unchanged', () => {
    assert.equal(
      invalidatesIndex(config({ languages: ['go', 'typescript'] }), config({ languages: ['typescript', 'go'] })),
      false,
    )
  })
})

describe('card projection', () => {
  it('projects a ready result with its freshness', () => {
    const meta = cardMeta({
      hits: [],
      freshness: { status: 'ready', head: 'abc123', dirtyFiles: 2, builtAt: 1000 },
    })
    assert.equal(meta.status, 'ready')
    assert.deepEqual(meta.freshness, { dirtyFiles: 2, builtAt: 1000, head: 'abc123' })
    assert.equal(meta.totals, undefined)
  })

  it('carries the overview totals and languages', () => {
    const meta = cardMeta({
      totals: { files: 4, symbols: 40, edges: 12, tests: 1, callResolution: 0.5 },
      languages: [{ lang: 'typescript', files: 3 }, { lang: 'go', files: 1 }],
      freshness: { status: 'stale', head: null, dirtyFiles: 0, builtAt: null },
    })
    assert.equal(meta.status, 'stale')
    assert.deepEqual(meta.totals, { files: 4, symbols: 40, edges: 12, tests: 1 })
    assert.deepEqual(meta.languages, [{ lang: 'typescript', files: 3 }, { lang: 'go', files: 1 }])
  })

  it('projects a build that has not finished', () => {
    const meta = cardMeta({
      status: 'building',
      message: 'still building',
      progress: { parsed: 12, total: 40, phase: 'parsing' },
    })
    assert.equal(meta.status, 'building')
    assert.deepEqual(meta.progress, { parsed: 12, total: 40, phase: 'parsing' })
  })

  it('projects an unavailable index with no progress', () => {
    assert.deepEqual(cardMeta({ status: 'unavailable', message: 'no repo', progress: null }),
      { status: 'unavailable' })
  })

  it('stays JSON-serializable and says nothing about a result it cannot read', () => {
    assert.equal(cardMeta({ hits: [] }), null)
    assert.equal(cardMeta('not an object'), null)
    assert.equal(JSON.stringify(cardMeta({ status: 'building', progress: null })), '{"status":"building"}')
  })
})
