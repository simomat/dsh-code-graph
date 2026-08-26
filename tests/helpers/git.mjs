/**
 * Git plumbing for fixture repositories.
 *
 * The index reads `git status --porcelain` and `git diff` to decide what went
 * stale out of band, so several suites need a fixture that is a real
 * repository rather than a bare directory.
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Run git in `cwd` and return stdout. Rejects on a non-zero exit. */
export async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** Whether a usable git is on PATH. */
export function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Turn a directory into a committed repository.
 *
 * Identity is set locally because a machine without a global `user.email`
 * cannot commit, and CI images frequently have none.
 *
 * @param cwd - the fixture root.
 * @param force - stage ignored files too, for fixtures that carry a .gitignore.
 * @param commit - leave the initial commit out, for tests that want a git
 *   repository with no HEAD.
 */
export async function initRepo(cwd, { force = false, commit = true } = {}) {
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'test@test.com'])
  await git(cwd, ['config', 'user.name', 'Test'])
  await git(cwd, ['add', '-A', ...(force ? ['-f'] : [])])
  if (commit) await git(cwd, ['commit', '-m', 'initial'])
}

/** Stage everything and commit. */
export async function commitAll(cwd, message) {
  await git(cwd, ['add', '-A'])
  await git(cwd, ['commit', '-m', message])
}
