/**
 * The one CSV schema every scenario writes into.
 *
 * Sparse on purpose: a `corpus-baseline` row leaves the index-profile columns
 * empty and vice versa. One schema beats five, because the aggregates and the
 * error-exclusion rule are then written once rather than per scenario — and the
 * rule that a thrown tool call must never reach an aggregate is exactly the kind
 * of thing that rots when each scenario keeps its own bookkeeping.
 *
 * An empty cell means "this column does not apply to this row" or "the result
 * genuinely could not say". Neither is ever written as `0`: a zero here would be
 * a measurement, and inventing one is how a failure starts looking like a win.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Every column, in write order. */
export const COLUMNS = [
  'run_id',
  'date',
  'scenario',
  'repo',
  'repo_sha',
  'question_id',
  'tool',
  'budget_limit',
  'status',
  'error',
  'baseline_kind',
  'baseline_tokens',
  'graph_tokens',
  'ratio',
  'truncated',
  'truncation_cause',
  'returned_rows',
  'total_rows',
  'dropped_rows',
  'estimated',
  'real_tokens',
  'est_real_ratio',
  'files',
  'nodes',
  'edges',
  'call_resolution',
  'db_bytes',
  'node_version',
  'elapsed_ms',
]

/**
 * Render one cell.
 *
 * `null` and `undefined` both become empty rather than the strings "null" and
 * "undefined", which a spreadsheet would read as data.
 * @param value - the cell value.
 * @returns A CSV-safe string.
 */
export function formatCell(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'boolean' ? String(value) : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

/**
 * Render rows as a CSV document.
 * @param rows - row objects keyed by column name.
 * @returns The document, header included, newline-terminated.
 */
export function toCsv(rows) {
  const lines = [COLUMNS.join(',')]
  for (const row of rows) lines.push(COLUMNS.map((c) => formatCell(row[c])).join(','))
  return `${lines.join('\n')}\n`
}

/**
 * Write rows to disk, creating the directory if needed.
 * @param path - destination file path.
 * @param rows - row objects keyed by column name.
 * @returns The path written.
 */
export function writeCsv(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, toCsv(rows))
  return path
}
