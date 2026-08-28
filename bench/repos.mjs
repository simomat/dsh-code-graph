/**
 * Getting the exact tree the numbers claim to describe.
 *
 * Determinism here is not a nicety: a benchmark that measured a slightly
 * different tree than its own table says it did is worse than no benchmark,
 * because nothing about the output reveals it. So:
 *
 * - **full clones**, never `--depth`, because a shallow clone cannot be moved
 *   to an arbitrary pinned commit and will silently measure whatever it has;
 * - **pinned SHAs**, verified with `git rev-parse HEAD` *after* checkout, with a
 *   mismatch aborting the whole run rather than annotating a row;
 * - **a clean working tree**, checked, because a stray edit in a cached clone
 *   would otherwise travel from run to run.
 *
 * Clones are cached in `bench/.repos/` and reused across runs. The cache is only
 * ever trusted after the two checks above pass; the index built over it is a
 * different matter and is always built fresh — see `graph.mjs`.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Run git in a directory.
 * @param cwd - working directory.
 * @param args - git arguments.
 * @returns Trimmed stdout.
 */
async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * The Node version this run is allowed to produce numbers on.
 *
 * Below 26 is a hard failure — `node:sqlite` and type stripping are both load
 * bearing. A different patch release is a warning rather than an abort: pinning
 * to the exact `.tool-versions` line would break the harness on every Node
 * release, and the running version is recorded in every row anyway, which is
 * what actually makes a cross-run comparison checkable.
 * @param repoRoot - this repository's root, holding `.tool-versions`.
 * @returns `{ version, pinned, matchesPin }`.
 */
export async function checkNodeVersion(repoRoot) {
  const version = process.versions.node
  const major = Number(version.split('.')[0])
  if (major < 26) {
    throw new Error(`bench requires Node >= 26 (node:sqlite, type stripping); running ${version}`)
  }
  let pinned = null
  try {
    const toolVersions = await readFile(join(repoRoot, '.tool-versions'), 'utf8')
    pinned = toolVersions.match(/^nodejs\s+(\S+)/m)?.[1] ?? null
  } catch {
    pinned = null
  }
  const matchesPin = pinned === null ? null : pinned === version
  if (matchesPin === false) {
    process.stderr.write(
      `warning: running Node ${version}, but .tool-versions pins ${pinned}. `
      + 'Numbers stay comparable only against runs on the same version; it is recorded per row.\n',
    )
  }
  return { version, pinned, matchesPin }
}

/**
 * Clone if absent, move to the pinned commit, and prove we got there.
 * @param repo - a repo entry from `bench/config.mjs`.
 * @param options - where to cache clones, and this repository's root.
 * @param options.cacheDir - directory holding cached clones.
 * @param options.repoRoot - this repository's root, for the `self` entry.
 * @returns `{ name, dir, sha, url }` with `sha` the verified checked-out commit.
 */
export async function prepareRepo(repo, { cacheDir, repoRoot }) {
  await mkdir(cacheDir, { recursive: true })
  const dir = join(cacheDir, repo.name)
  const url = repo.self ? repoRoot : repo.url

  // `self` has no fixed pin: it is whatever this working copy has committed.
  // Cloning it rather than measuring the working tree is what keeps the
  // measured tree clean even when the developer's is not.
  const wanted = repo.self ? await git(repoRoot, ['rev-parse', 'HEAD']) : repo.sha

  if (!existsSync(join(dir, '.git'))) {
    process.stderr.write(`cloning ${repo.name} (full clone, this is the slow first run)\n`)
    await run('git', ['clone', '--no-single-branch', url, dir], { maxBuffer: 64 * 1024 * 1024 })
  }

  // A cached clone predating the pin will not have the commit yet.
  const has = async () => await git(dir, ['cat-file', '-t', `${wanted}^{commit}`]).catch(() => null) === 'commit'
  if (!await has()) await git(dir, ['fetch', '--tags', '--force', 'origin'])
  // Say what is wrong here rather than letting `git checkout` fail: a pin that
  // does not exist upstream is a typo in `bench/config.mjs`, and the raw git
  // error does not say so.
  if (!await has()) {
    throw new Error(
      `${repo.name}: pinned commit ${wanted} does not exist in ${url}, even after fetching. `
      + 'Check the `sha` in bench/config.mjs — an annotated tag needs its peeled commit '
      + '(`git rev-parse <tag>^{commit}`), not the tag object.',
    )
  }

  await git(dir, ['checkout', '--detach', '--force', wanted])
  await git(dir, ['clean', '-fdx', '--quiet'])

  const head = await git(dir, ['rev-parse', 'HEAD'])
  if (head !== wanted) {
    throw new Error(
      `${repo.name}: checked out ${head} but the pin is ${wanted}. `
      + 'Refusing to measure a tree the results would misdescribe.',
    )
  }
  const dirty = await git(dir, ['status', '--porcelain'])
  if (dirty !== '') {
    throw new Error(`${repo.name}: working tree is dirty after checkout:\n${dirty}`)
  }

  return { name: repo.name, dir, sha: head, url, lang: repo.lang, tag: repo.tag ?? null }
}
