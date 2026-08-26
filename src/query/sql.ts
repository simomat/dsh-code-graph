/** SQL LIKE helpers. User strings must not be interpolated as wildcards. */

/** Escape `%`, `_`, and `\` so they match literally under `ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (ch) => `\\${ch}`)
}

/** `dir/%` prefix match for a repo-relative directory, with wildcards escaped. */
export function pathPrefixLike(dir: string): string {
  return `${escapeLike(dir)}/%`
}

/** Convert a simple glob (`*`, `?`) to a LIKE pattern with escaped literals. */
export function globToLike(glob: string): string {
  return escapeLike(glob).replaceAll('*', '%').replaceAll('?', '_')
}

/**
 * Placeholders per statement, kept well clear of every SQLite build's limit.
 *
 * `SQLITE_MAX_VARIABLE_NUMBER` is 32766 on this Node build and 999 on older
 * ones; 900 leaves room for the fixed parameters a query binds alongside a
 * chunked `IN` list.
 */
export const SQL_PARAM_CHUNK = 900

/**
 * Split values into batches small enough to bind as one `IN` list.
 *
 * @param items - values destined for a single `IN (...)`.
 * @param size - maximum placeholders per statement.
 * @returns One batch per statement; a single batch for the common small case.
 */
export function chunked<T>(items: T[], size: number = SQL_PARAM_CHUNK): T[][] {
  if (items.length <= size) return items.length > 0 ? [items] : []
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}
