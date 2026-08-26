/**
 * Tool-argument guards used by the Cordis execute handlers.
 * Kept out of `index.ts` so they can be unit-tested without the harness.
 */

export function requireNonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`)
  return value
}

export function requirePaths(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) throw new Error('paths must not be empty')
  return paths
}
