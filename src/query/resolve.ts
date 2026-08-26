/**
 * Shared symbol lookup used by code_relations and code_impact.
 *
 * Order: exact qname → file path → bare name among non-file nodes.
 *
 * A bare name matching several nodes is *ambiguous*, which is a different
 * answer from *not found*: the symbol exists and the caller only has to say
 * which one it meant. Reporting both as `null` sent the agent back to grep for
 * a question one more tool call could settle, so the candidates come back with
 * the verdict.
 */
import type { GraphDb } from '../db.ts'

/** How many candidate qnames an ambiguous match reports back. */
export const MAX_CANDIDATES = 10

export type Resolution =
  | { status: 'resolved'; qname: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not-found' }

/** One query that matched several symbols, with the qnames to choose from. */
export interface AmbiguousTarget {
  query: string
  candidates: string[]
}

/**
 * Resolve one query to a symbol.
 * @param db - the open graph database.
 * @param query - qname, file path, or bare symbol name.
 * @returns The resolved qname, the candidates when ambiguous, or not-found.
 */
export function resolveSymbol(db: GraphDb, query: string): Resolution {
  const exact = db.db
    .prepare('SELECT qname FROM nodes WHERE qname = ?')
    .get(query) as { qname?: string } | undefined
  if (exact?.qname) return { status: 'resolved', qname: exact.qname }

  const pathMatch = db.db
    .prepare("SELECT qname FROM nodes WHERE path = ? AND kind = 'file' LIMIT 1")
    .get(query) as { qname?: string } | undefined
  if (pathMatch?.qname) return { status: 'resolved', qname: pathMatch.qname }

  // One over the reported maximum, so a longer candidate list is still ordered
  // and bounded rather than silently cut at an arbitrary point.
  const matches = db.db
    .prepare(`SELECT qname FROM nodes WHERE name = ? AND kind != 'file' ORDER BY qname LIMIT ?`)
    .all(query, MAX_CANDIDATES + 1) as Array<{ qname: string }>
  if (matches.length === 1) return { status: 'resolved', qname: matches[0]!.qname }
  if (matches.length > 1) {
    return { status: 'ambiguous', candidates: matches.slice(0, MAX_CANDIDATES).map((r) => r.qname) }
  }

  return { status: 'not-found' }
}

/**
 * Resolve one query, collapsing ambiguity to a miss.
 * @param db - the open graph database.
 * @param query - qname, file path, or bare symbol name.
 * @returns The resolved qname, or null when it is unknown or ambiguous.
 */
export function resolveQname(db: GraphDb, query: string): string | null {
  const hit = resolveSymbol(db, query)
  return hit.status === 'resolved' ? hit.qname : null
}

/**
 * Resolve a batch of queries, keeping the three verdicts apart.
 * @param db - the open graph database.
 * @param queries - qnames, file paths, or bare symbol names.
 * @returns Resolved qnames, queries with no match, and ambiguous ones with
 *   their candidates. `unresolved` means *absent*; an ambiguous query is not
 *   in it.
 */
export function resolveTargets(
  db: GraphDb,
  queries: string[],
): { resolved: string[]; unresolved: string[]; ambiguous: AmbiguousTarget[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  const ambiguous: AmbiguousTarget[] = []
  for (const q of queries) {
    const hit = resolveSymbol(db, q)
    if (hit.status === 'resolved') resolved.push(hit.qname)
    else if (hit.status === 'ambiguous') ambiguous.push({ query: q, candidates: hit.candidates })
    else unresolved.push(q)
  }
  return { resolved, unresolved, ambiguous }
}
