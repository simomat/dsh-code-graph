/**
 * Column accessors for `node:sqlite` result rows.
 *
 * `prepare(...).all()` hands back `Record<string, unknown>`, so every read site
 * re-derives its own columns by hand. These five functions are that cast written
 * once — and, more to the point, one spelling for the nullable case, which was
 * written three different ways across `build.ts` and the query modules.
 *
 * Root-level rather than in `query/sql.ts`: `index/build.ts` is the heaviest
 * consumer and sits below `query/` in the layering, so the helpers cannot live
 * there without pointing an import upward.
 *
 * The `?? ''` / `?? 0` defaults are deliberate. A NOT NULL column never reaches
 * them; a column that does is better read as empty than as the string `"null"`.
 * Use {@link nullable} or {@link optional} where the null is meaningful.
 */

/** One row as `node:sqlite` returns it. */
export type SqlRow = Record<string, unknown>

/**
 * Text column, for a NOT NULL column or one whose absence has a sensible value.
 * @param row - the result row.
 * @param col - column name as selected.
 * @param fallback - substituted when the column is `NULL`.
 */
export function str(row: SqlRow, col: string, fallback = ''): string {
  return String(row[col] ?? fallback)
}

/** Numeric column, `NULL` read as `0`. */
export function num(row: SqlRow, col: string): number {
  return Number(row[col] ?? 0)
}

/** Nullable text column, `NULL` preserved as `null`. */
export function nullable(row: SqlRow, col: string): string | null {
  const value = row[col]
  return value === null || value === undefined ? null : String(value)
}

/** Nullable text column, `NULL` preserved as `undefined`. */
export function optional(row: SqlRow, col: string): string | undefined {
  const value = row[col]
  return value === null || value === undefined ? undefined : String(value)
}

/** SQLite integer boolean: `1` is true, everything else false. */
export function flag(row: SqlRow, col: string): boolean {
  return Number(row[col] ?? 0) === 1
}
