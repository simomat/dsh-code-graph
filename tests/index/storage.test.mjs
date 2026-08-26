/**
 * What the storage layer does with a file it has already seen.
 *
 * Two decisions live here: whether a file needs reparsing at all, and how an
 * upsert keeps the search index pointed at the node it belongs to.
 */
import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { describe, it } from 'node:test'

import { hashContent, incrementalBuild } from '../../src/index/build.ts'
import { createFixture } from '../helpers/fixture.mjs'
import { assertFtsConsistent } from '../helpers/invariants.mjs'

describe('file fingerprints', () => {
  it('reparses when mtime changes and hash differs', async () => {
    const fx = createFixture('cg-hash-')
    try {
      fx.write('src/a.ts', 'export const CONST = 42\n')
      const db = await fx.build()
      const abs = fx.write('src/a.ts', 'export const CONST = 99\n')
      utimesSync(abs, new Date(), new Date(Date.now() + 2000))
      const result = await incrementalBuild(db, fx.root, [])
      assert.ok(result.filesIndexed >= 1, 'content change reindexed')
      const stored = db.db.prepare("SELECT hash FROM files WHERE path='src/a.ts'").get()
      assert.equal(stored.hash, hashContent('export const CONST = 99\n'))
    } finally {
      fx.cleanup()
    }
  })

  it('skips touch-only mtime when hash is unchanged', async () => {
    const fx = createFixture('cg-touch-')
    try {
      const abs = fx.write('src/a.ts', 'export const CONST = 42\n')
      const db = await fx.build()
      utimesSync(abs, new Date(), new Date(Date.now() + 2000))
      assert.equal(hashContent('export const CONST = 42\n').length, 64)
      const result = await incrementalBuild(db, fx.root, [])
      assert.equal(result.filesIndexed, 0, 'touch without content change is a no-op')
    } finally {
      fx.cleanup()
    }
  })
})

/**
 * B2 at the storage layer: `writeFile` upserts nodes by qname, and the FTS
 * entry must follow the node it belongs to rather than whatever row happened to
 * be inserted last.
 */
describe('duplicate qnames', () => {
  const fileRow = (path) => ({
    path, hash: 'h', lang: 'java', mtimeMs: 0, size: 0, parsedAt: 0, parseError: null,
  })
  const methodNode = (path, qname, name, signature) => ({
    qname, kind: 'method', name, path, lang: 'java',
    lineStart: 1, lineEnd: 1, parent: null, signature, exported: 1, isTest: 0, loc: 1,
  })

  it('indexes an upserted node against its own rowid', () => {
    const fx = createFixture('cg-dup-')
    try {
      const db = fx.open()
      const path = 'src/Widget.java'
      // Non-adjacent duplicate: the collision lands two rows after the
      // last inserted one, which is what exposes a stale last_insert_rowid().
      db.writeFile(fileRow(path), [
        methodNode(path, 'W.render', 'render', 'render(String s)'),
        methodNode(path, 'W.helperAlphaOnly', 'helperAlphaOnly', 'helperAlphaOnly()'),
        methodNode(path, 'W.render', 'render', 'render(int n)'),
      ], [], [])

      const hits = db.db.prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?').all('"render"')
      const owner = db.db.prepare("SELECT rowid FROM nodes WHERE qname='W.render'").get()
      assert.deepEqual(hits.map((h) => h.rowid), [owner.rowid], 'no unrelated node matches "render"')

      // The superseded entry's tokens must not linger either.
      const stale = db.db.prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?').all('"String"')
      assert.deepEqual(stale, [], 'overwritten signature left tokens behind')

      assertFtsConsistent(db, 'duplicate qname upsert')
    } finally {
      fx.cleanup()
    }
  })

  it('keeps merged TypeScript declarations as separate nodes', async () => {
    const fx = createFixture('cg-merge-')
    try {
      fx.write('src/a.ts', [
        'export interface Shape { a: number }',
        'export function marker(): void {}',
        'export interface Shape { b: number }',
        '',
      ].join('\n'))
      const db = await fx.build()
      const shapes = db.db.prepare("SELECT qname FROM nodes WHERE name='Shape'").all()
      assert.equal(shapes.length, 2, 'both interface declarations survive')
      assertFtsConsistent(db, 'ts declaration merging')
    } finally {
      fx.cleanup()
    }
  })
})
