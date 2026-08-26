/**
 * File universe discovery.
 *
 * `git ls-files` is the primary source: it applies .gitignore for free and is
 * effectively instantaneous (measured ~3ms on a 5k-file checkout). When git is
 * absent or the directory is not a repository, a bounded directory walk with a
 * built-in ignore list keeps the plugin working instead of failing hard.
 *
 * The two universes are not interchangeable — the walk skips `IGNORED_DIRS` and
 * every dot-directory, and includes gitignored files git would omit — so
 * `listFiles` reports which one produced the listing. Callers that treat absence
 * from the listing as "deleted" must check the source first; see
 * `incrementalBuild`.
 */
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { isAbortError, throwIfAborted } from '../abort.ts'

const execFileAsync = promisify(execFile)

/** Directories never worth indexing, used by the non-git fallback. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'lib',
  'coverage', '.next', '.nuxt', '.cache', '.turbo', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', '.dsh', '.idea', '.vscode',
])

export interface GitState {
  /** True when the root is inside a git work tree. */
  isRepo: boolean
  /** Current HEAD commit, or undefined outside a repo / on an unborn branch. */
  head?: string
}

async function git(root: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  throwIfAborted(signal)
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20_000,
      ...(signal ? { signal } : {}),
    })
    return stdout
  } catch (error) {
    if (isAbortError(error)) throw error
    return undefined
  }
}

/**
 * Read the repository's current git state.
 * @param root - absolute repository root.
 * @returns Whether the root is a repo, and its HEAD commit when available.
 */
export async function gitState(root: string, signal?: AbortSignal): Promise<GitState> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], signal)
  if (inside?.trim() !== 'true') return { isRepo: false }
  const head = (await git(root, ['rev-parse', 'HEAD'], signal))?.trim()
  return head ? { isRepo: true, head } : { isRepo: true }
}

/**
 * List paths git reports as modified, added, or untracked-but-not-ignored.
 * Used by the freshness check to spot out-of-band edits cheaply.
 * @param root - absolute repository root.
 * @returns Repo-relative paths, or undefined when git is unavailable.
 */
export async function gitDirtyPaths(root: string, signal?: AbortSignal): Promise<string[] | undefined> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)
  if (out === undefined) return undefined
  return parsePorcelainZ(out)
}

/**
 * Parse `git status --porcelain=v1 -z` output into repo-relative paths.
 * Rename/copy records are two NUL fields: `XY <new>` then the original path
 * with no XY prefix (`-z` reverses the arrow form's order). Both paths are
 * returned so the incremental builder can purge the old file and index the
 * new one.
 */
export function parsePorcelainZ(out: string): string[] {
  const paths: string[] = []
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry === undefined || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (xy.startsWith('R') || xy.startsWith('C')) {
      i += 1
      const dest = entries[i]
      if (dest && dest.length > 0) paths.push(dest)
    }
  }
  return paths
}

/**
 * List every file changed between a git ref and the working tree.
 * @param root - absolute repository root.
 * @param base - the git ref to diff against.
 * @returns Repo-relative paths, or undefined when the ref cannot be resolved.
 */
export async function gitChangedSince(
  root: string,
  base: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const out = await git(root, ['diff', '--name-only', '-z', base], signal)
  if (out === undefined) return undefined
  return out.split('\0').filter((p) => p.length > 0)
}

function walkDir(
  root: string,
  dir: string,
  acc: string[],
  budget: { left: number },
  excluded: (path: string) => boolean,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal)
  if (budget.left <= 0) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    throwIfAborted(signal)
    if (budget.left <= 0) return
    const full = join(dir, entry.name)
    const rel = relative(root, full).split(sep).join('/')
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      // Pruning here rather than filtering the result keeps an excluded tree
      // off the disk entirely, which is the whole point of excluding it.
      if (excluded(rel)) continue
      walkDir(root, full, acc, budget, excluded, signal)
    } else if (entry.isFile()) {
      if (excluded(rel)) continue
      acc.push(rel)
      budget.left -= 1
    }
  }
}

/** Which enumeration strategy produced a file listing. */
export type FileSource = 'git' | 'walk'

export interface FileListing {
  /** Repo-relative paths in stable order. */
  files: string[]
  /** `'git'` when git answered; `'walk'` when the directory fallback was used. */
  source: FileSource
}

/** Options narrowing what {@link listFiles} enumerates. */
export interface ListOptions {
  /** Hard ceiling protecting against pathological trees. */
  maxFiles?: number | undefined
  /** User-supplied exclusions, additive over the built-in list. */
  exclude?: readonly string[] | undefined
  signal?: AbortSignal | undefined
}

/**
 * Build the predicate one exclusion list stands for.
 *
 * An entry without a slash is a directory *name* matched against every path
 * segment, which is how a user thinks about `node_modules` or `fixtures`. An
 * entry with a slash is a path prefix anchored at the repository root, which is
 * how a user names one particular tree. Nothing here is a glob: a pattern
 * language would need documenting, and these two forms cover what the built-in
 * list already expresses.
 * @param exclude - raw entries as configured; blanks are ignored.
 * @returns A predicate over repo-relative paths.
 */
export function excludeMatcher(exclude: readonly string[] = []): (path: string) => boolean {
  const names = new Set<string>()
  const prefixes: string[] = []
  for (const raw of exclude) {
    const entry = raw.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '')
    if (entry.length === 0) continue
    if (entry.includes('/')) prefixes.push(entry)
    else names.add(entry)
  }
  if (names.size === 0 && prefixes.length === 0) return () => false
  return (path) => {
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(`${prefix}/`)) return true
    }
    if (names.size === 0) return false
    return path.split('/').some((segment) => names.has(segment))
  }
}

/**
 * Enumerate every candidate file in the repository.
 *
 * Exclusions are applied here rather than inside either enumeration strategy,
 * because this is the one place both meet: `git ls-files` already honours
 * `.gitignore` and knows nothing of the built-in walk list, so a user exclusion
 * that only pruned the walk would do nothing in an ordinary git checkout.
 * @param root - absolute repository root.
 * @param options - ceiling, exclusions, and cancellation.
 * @returns The repo-relative paths and the source that produced them.
 */
export async function listFiles(root: string, options: ListOptions = {}): Promise<FileListing> {
  const { maxFiles = 200_000, exclude, signal } = options
  const excluded = excludeMatcher(exclude)
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)
  if (out !== undefined) {
    const files = out.split('\0').filter((p) => p.length > 0 && !excluded(p))
    return { files: files.length > maxFiles ? files.slice(0, maxFiles) : files, source: 'git' }
  }
  const acc: string[] = []
  walkDir(root, root, acc, { left: maxFiles }, excluded, signal)
  acc.sort()
  return { files: acc, source: 'walk' }
}
