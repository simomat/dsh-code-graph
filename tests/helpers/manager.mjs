/**
 * IndexManager wiring for tests.
 *
 * The manager owns the database file, so each one gets a private directory —
 * a shared path in tmpdir collides between concurrent runs of the same suite
 * and leaves the file behind afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphDb } from '../../src/db.ts'
import { IndexManager } from '../../src/index/manager.ts'

/**
 * A manager over a private on-disk graph.
 *
 * @param open - override how the graph is opened, for tests that need to
 *   observe or fail the call.
 * @returns the manager, its database path, a `dispose` that also removes the
 *   directory, and `removeDb` for tests that dispose the manager themselves.
 */
export function makeManager({ open = (path, repoRoot) => GraphDb.open(path, repoRoot) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-mgr-'))
  const dbPath = join(dir, 'graph.db')
  const manager = new IndexManager({ resolveDbPath: () => dbPath, open })
  const removeDb = () => rmSync(dir, { recursive: true, force: true })
  return {
    manager,
    dbPath,
    removeDb,
    dispose() {
      manager.dispose()
      removeDb()
    },
  }
}

/** The shape of a tool execution the manager reads the working directory from. */
export function execLike(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** Acquire a graph, failing the test if the manager reports anything but ready. */
export async function acquireOnce(manager, exec) {
  const result = await manager.acquire(exec)
  if (result.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(result)}`)
  return result.db
}
