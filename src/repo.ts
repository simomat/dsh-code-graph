/**
 * Canonical repository identity.
 *
 * Session cwd, trailing slashes, and symlink aliases must hash to one graph
 * database and one manager entry. Otherwise the same checkout gets two indexes
 * that diverge independently.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function stripTrailingSep(path: string): string {
  if (path.length <= 1) return path
  return path.replace(/[/\\]+$/, '') || path
}

/**
 * Resolve a filesystem path, following symlinks when the target exists.
 * Deleted files fall back to realpath of the parent so a symlink checkout
 * still maps onto the canonical repo root.
 */
export function canonicalizePath(path: string): string {
  const abs = resolve(path)
  try {
    return stripTrailingSep(realpathSync(abs))
  } catch {
    try {
      return stripTrailingSep(join(realpathSync(dirname(abs)), basename(abs)))
    } catch {
      return stripTrailingSep(abs)
    }
  }
}

/** Canonical absolute directory used as the repository key. */
export function canonicalizeRepoRoot(cwd: string): string {
  return canonicalizePath(cwd)
}
