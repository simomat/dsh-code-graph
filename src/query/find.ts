/**
 * Symbol search — the direct replacement for a grep-then-read loop.
 *
 * Returns signatures and locations only, never file bodies: the agent gets
 * enough to decide what to open, and opens it with the ordinary `read` tool
 * using the exact line this returns.
 */
import type { GraphDb } from '../db.ts'
import { flag, nullable, num, type SqlRow, str } from '../row.ts'
import { type BudgetedRows, fitRows } from './budget.ts'
import { globToLike } from './sql.ts'

export interface FindHit {
  qname: string
  kind: string
  name: string
  path: string
  line: number
  signature: string | null
  exported: boolean
  isTest: boolean
  /** Distinct symbols that call this one (resolved edges only). */
  callers: number
  /** Distinct symbols this one calls (resolved edges only). */
  callees: number
}

export interface FindOptions {
  query: string
  kind?: string | undefined
  pathGlob?: string | undefined
  limit?: number | undefined
  budget: number
}

/** Escape a user string for an FTS5 MATCH phrase. */
function ftsPhrase(query: string): string {
  const cleaned = query.replace(/["*]/g, ' ').trim()
  if (cleaned.length === 0) return ''
  // Prefix-match the final term so partial names still hit.
  const terms = cleaned.split(/\s+/).map((t) => `"${t}"`)
  const last = terms.pop()
  return [...terms, `${last?.slice(0, -1)}"*`].join(' ')
}

/**
 * Search the graph for symbols matching a query.
 *
 * Ranking is deliberately simple and explainable: exact name, then prefix,
 * then FTS relevance; ties broken by caller count so the structurally central
 * definition surfaces first.
 * @param db - the open graph database.
 * @param opts - search parameters including the token budget.
 * @returns Budget-limited hits with truncation bookkeeping.
 */
export function findSymbols(db: GraphDb, opts: FindOptions): BudgetedRows<FindHit> & { total: number } {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 40))
  const params: unknown[] = []
  const where: string[] = []

  const phrase = ftsPhrase(opts.query)
  const exact = opts.query.trim()

  // Candidate set: FTS match unioned with an exact-name lookup, so a short or
  // punctuation-heavy query still finds its symbol even when FTS yields nothing.
  let sql = `
    WITH matched AS (
      SELECT rowid AS rid FROM nodes_fts WHERE nodes_fts MATCH ?
      UNION
      SELECT rowid AS rid FROM nodes WHERE name = ?
    )
    SELECT n.qname, n.kind, n.name, n.path, n.line_start, n.signature,
           n.exported, n.is_test,
           (SELECT COUNT(DISTINCT e.src) FROM edges e
              WHERE e.dst = n.qname AND e.kind = 'CALLS'
                AND e.resolved = 1 AND e.confidence >= 0.8) AS callers,
           (SELECT COUNT(DISTINCT e.dst) FROM edges e
              WHERE e.src = n.qname AND e.kind = 'CALLS'
                AND e.resolved = 1 AND e.confidence >= 0.8) AS callees
    FROM nodes n
    WHERE n.rowid IN (SELECT rid FROM matched)
      AND n.kind != 'file'
  `
  params.push(phrase.length > 0 ? phrase : '""', exact)

  if (opts.kind) {
    where.push('n.kind = ?')
    params.push(opts.kind)
  }
  if (opts.pathGlob) {
    where.push("n.path LIKE ? ESCAPE '\\'")
    params.push(globToLike(opts.pathGlob))
  }
  if (where.length > 0) sql += ` AND ${where.join(' AND ')}`

  const countSql = `
    WITH matched AS (
      SELECT rowid AS rid FROM nodes_fts WHERE nodes_fts MATCH ?
      UNION
      SELECT rowid AS rid FROM nodes WHERE name = ?
    )
    SELECT COUNT(*) AS c FROM nodes n
    WHERE n.rowid IN (SELECT rid FROM matched)
      AND n.kind != 'file'${where.length > 0 ? ` AND ${where.join(' AND ')}` : ''}
  `
  const countParams = params.slice()
  let total = 0
  try {
    const countRow = db.db.prepare(countSql).get(...(countParams as never[])) as { c?: number } | undefined
    total = Number(countRow?.c ?? 0)
  } catch {
    total = 0
  }

  sql += `
    ORDER BY
      CASE WHEN n.name = ? THEN 0
           WHEN n.name LIKE ? ESCAPE '\\' THEN 1
           ELSE 2 END,
      n.exported DESC,
      callers DESC,
      LENGTH(n.name) ASC
    LIMIT ?
  `
  params.push(exact, `${globToLike(exact)}%`, limit)

  let rows: SqlRow[]
  try {
    rows = db.db.prepare(sql).all(...(params as never[])) as SqlRow[]
  } catch {
    // A malformed FTS expression must degrade to an exact-name lookup, not fail.
    rows = db.db
      .prepare(
        `SELECT qname, kind, name, path, line_start, signature, exported, is_test,
                0 AS callers, 0 AS callees
         FROM nodes WHERE name = ? AND kind != 'file' LIMIT ?`,
      )
      .all(exact, limit) as SqlRow[]
  }

  const hits: FindHit[] = rows.map((r) => ({
    qname: str(r, 'qname'),
    kind: str(r, 'kind'),
    name: str(r, 'name'),
    path: str(r, 'path'),
    line: num(r, 'line_start'),
    signature: nullable(r, 'signature'),
    exported: flag(r, 'exported'),
    isTest: flag(r, 'is_test'),
    callers: num(r, 'callers'),
    callees: num(r, 'callees'),
  }))

  const fitted = fitRows(hits, opts.budget, 60)
  return { ...fitted, total: total > 0 ? total : hits.length }
}
