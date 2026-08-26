/**
 * A throwaway repository on disk, plus the graph built over it.
 *
 * Every suite here works the same way: make a temp directory, write a handful
 * of source files into it, index them, and assert against the result. The
 * mechanics of that were copy-pasted into eight files; they live here now.
 *
 * Fixture content is deliberately *not* shared — the exact-count assertions
 * ("indexes 9 files") only mean something when the file a test reads sits next
 * to the numbers it produces.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphDb } from '../../src/db.ts'
import { fullBuild } from '../../src/index/build.ts'

/**
 * Create an empty fixture repository.
 *
 * The temp directory exists as soon as this returns, so a fixture can be made
 * at module scope and populated in a `before` hook, or made and torn down
 * inside a single test. The caller always owns `cleanup()`.
 *
 * @param prefix - mkdtemp prefix, to make a stray directory identifiable.
 */
export function createFixture(prefix = 'cg-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  /** @type {import('../../src/db.ts').GraphDb | undefined} */
  let db

  /** Write a file, creating parent directories. Returns the absolute path. */
  const write = (rel, text) => {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
    return abs
  }

  return {
    root,
    write,
    /** Write a `{ relativePath: contents }` map in one call. */
    writeAll(files) {
      for (const [rel, text] of Object.entries(files)) write(rel, text)
    },
    /** Absolute path of something inside the fixture. */
    path: (rel) => join(root, rel),
    /** Delete a path inside the fixture. */
    remove: (rel) => rmSync(join(root, rel), { recursive: true, force: true }),

    /** Open a graph over this fixture without indexing it. */
    open(dbPath = ':memory:') {
      db = GraphDb.open(dbPath, root)
      return db
    },
    /** Open a graph and run a full index over the files written so far. */
    async build(dbPath = ':memory:') {
      const opened = this.open(dbPath)
      await fullBuild(opened, root)
      return opened
    },
    /** The open graph, once `open()` or `build()` has run. */
    get db() {
      return db
    },

    // Raw SQL against the graph, for assertions the query layer doesn't expose.
    // Late-bound to `db` so these survive destructuring before a `before` hook.
    all: (sql, ...params) => db.db.prepare(sql).all(...params),
    one: (sql, ...params) => db.db.prepare(sql).get(...params),

    /** Close the graph and delete the directory. Safe to call twice. */
    cleanup() {
      db?.close()
      db = undefined
      rmSync(root, { recursive: true, force: true })
    },
  }
}
