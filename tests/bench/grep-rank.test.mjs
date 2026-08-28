/**
 * The agent baseline's grep-and-read loop.
 *
 * This is the baseline the plugin's actual pitch rests on, so its ranking has to
 * be reproducible to the row. The tie-break on path is the load-bearing part:
 * without it the choice of which files an agent "reads" would fall back to
 * whatever order the index enumerated them in, and two runs over the same tree
 * could report different baselines.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { countOccurrences, deriveTerms, grepAndRead, rankFiles } from '../../bench/grep.mjs'

/** A reader over an in-memory tree, so ranking is tested without touching disk. */
const readerFor = (tree) => (abs) => {
  const key = abs.replace(/^\/repo\//, '')
  if (!(key in tree)) throw new Error(`no such file: ${key}`)
  return tree[key]
}

const filesOf = (tree) => Object.keys(tree).map((path) => ({ path }))

describe('term derivation', () => {
  it('lowercases, splits on non-word characters and de-duplicates', () => {
    assert.deepEqual(deriveTerms('Router.mounted, router-mounted'), ['router', 'mounted'])
  })

  it('drops stopwords and tokens shorter than the minimum', () => {
    // 'is', 'and', 'it' are function words or too short; 'defined' and 'calls'
    // are question framing, dropped so the baseline models an agent that greps
    // for the identifier rather than for the question.
    assert.deepEqual(deriveTerms('where is the Router defined and who calls it'), ['router'])
  })

  it('keeps identifier-shaped words a question is actually about', () => {
    assert.deepEqual(deriveTerms('How does createApplication build the app?'), ['createapplication', 'build', 'app'])
  })

  it('is a pure function of its input', () => {
    const q = 'what does the middleware stack do'
    assert.deepEqual(deriveTerms(q), deriveTerms(q))
  })
})

describe('occurrence counting', () => {
  it('counts every non-overlapping occurrence', () => {
    assert.equal(countOccurrences('router router router', 'router'), 3)
  })

  it('counts nothing for an empty term', () => {
    assert.equal(countOccurrences('anything', ''), 0)
  })

  it('is case-insensitive by contract — the caller lowercases both sides', () => {
    assert.equal(countOccurrences('Router'.toLowerCase(), 'router'), 1)
  })
})

describe('ranking', () => {
  it('orders by total matches across all terms, best first', () => {
    const tree = {
      'src/a.js': 'router router router',
      'src/b.js': 'router',
      'src/c.js': 'router router',
    }
    const ranked = rankFiles(filesOf(tree), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(ranked.map((r) => r.path), ['src/a.js', 'src/c.js', 'src/b.js'])
    assert.deepEqual(ranked.map((r) => r.matches), [3, 2, 1])
  })

  it('breaks ties on path, ascending', () => {
    const tree = { 'src/z.js': 'router', 'src/a.js': 'router', 'src/m.js': 'router' }
    const ranked = rankFiles(filesOf(tree), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(ranked.map((r) => r.path), ['src/a.js', 'src/m.js', 'src/z.js'])
  })

  it('gives the same order regardless of the order files arrive in', () => {
    const tree = { 'src/z.js': 'router', 'src/a.js': 'router' }
    const forward = rankFiles(filesOf(tree), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    const reversed = rankFiles(filesOf(tree).reverse(), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(forward, reversed, 'enumeration order must not reach the baseline')
  })

  it('sums matches over several terms', () => {
    const tree = { 'src/a.js': 'router', 'src/b.js': 'handle handle' }
    const ranked = rankFiles(filesOf(tree), ['router', 'handle'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(ranked.map((r) => r.path), ['src/b.js', 'src/a.js'])
  })

  it('drops files a grep would never surface', () => {
    const tree = { 'src/a.js': 'router', 'src/b.js': 'nothing relevant' }
    const ranked = rankFiles(filesOf(tree), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(ranked.map((r) => r.path), ['src/a.js'])
  })

  it('skips an unreadable file rather than failing the run', () => {
    const tree = { 'src/a.js': 'router' }
    const files = [{ path: 'src/a.js' }, { path: 'src/gone.js' }]
    const ranked = rankFiles(files, ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(ranked.map((r) => r.path), ['src/a.js'])
  })
})

describe('grep and read', () => {
  const tree = {
    'src/a.js': 'router router router',
    'src/b.js': 'router router',
    'src/c.js': 'router',
    'src/d.js': 'router',
  }

  it('reads the top three and reports how many candidates there were', () => {
    const out = grepAndRead(filesOf(tree), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.deepEqual(out.read.map((r) => r.path), ['src/a.js', 'src/b.js', 'src/c.js'])
    assert.equal(out.candidates, 4, 'the agent grepped four files even though it read three')
  })

  it('charges the agent for the whole file, not the matching line', () => {
    const out = grepAndRead(filesOf(tree), ['router'], { repoDir: '/repo', read: readerFor(tree) })
    assert.equal(out.read[0].chars, tree['src/a.js'].length)
  })

  it('honours a different read depth', () => {
    const out = grepAndRead(filesOf(tree), ['router'], { repoDir: '/repo', topN: 1, read: readerFor(tree) })
    assert.equal(out.read.length, 1)
  })
})
