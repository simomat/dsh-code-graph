/**
 * The small TypeScript repository the freshness suites index.
 *
 * Unlike the per-language fixtures, whose exact contents the assertions count,
 * this one is shared: `tests/index/*` cares about *what changed* between two
 * builds, not about how many symbols the repository has. Keeping one copy
 * means the incremental and manager suites cannot drift into testing subtly
 * different repositories.
 */
import { createFixture } from './fixture.mjs'
import { git as runGit, initRepo } from './git.mjs'
import { makeManager } from './manager.mjs'

/** Files of the repository, as a `{ relativePath: contents }` map. */
export const TS_SOURCES = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
  }),

  'src/util.ts': `
export function helper(x: number): number { return x * 2 }
export const CONST = 42
function privateHelper() { return 1 }
export function usesPrivate() { return privateHelper() }
`,

  'src/service.ts': `
import { helper } from './util'

export class Service {
  run(n: number): number {
    return helper(n)
  }
}
`,

  'src/index.ts': `
import { Service } from './service'
export function main(): number {
  const s = new Service()
  return s.run(21)
}
`,
}

/**
 * A committed git repository over `TS_SOURCES`, with a manager wired to it.
 *
 * Git is initialized because `gitDirtyPaths` and `gitChangedSince` are how the
 * index notices edits it was not told about.
 *
 * @returns a handle bundling the fixture, its manager, and a `cleanup` that
 *   disposes both.
 */
export async function createRepo(prefix = 'cg-repo-', sources = TS_SOURCES) {
  const fixture = createFixture(prefix)
  fixture.writeAll(sources)
  await initRepo(fixture.root)
  const managed = makeManager()
  let disposed = false
  return {
    fixture,
    root: fixture.root,
    manager: managed.manager,
    write: fixture.write,
    path: fixture.path,
    remove: fixture.remove,
    git: (args) => runGit(fixture.root, args),
    /** Drop the manager but keep the repository, for tests that supply their own. */
    disposeManager() {
      if (disposed) return
      managed.dispose()
      disposed = true
    },
    cleanup() {
      this.disposeManager()
      fixture.cleanup()
    },
  }
}
