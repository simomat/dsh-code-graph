/**
 * Symbol relation inspector — `code_relations`.
 *
 * Returns every edge touching a symbol, grouped by kind: callers, callees,
 * imports, inheritance, implementations, tests, references, and contained
 * symbols. Each edge carries confidence so the model knows which are real.
 *
 * Two independent limits shrink a section: a per-relation SQL cap and the
 * token budget. Both are reported — `counts` carries the true totals and
 * `truncated` is set whenever any section returns fewer rows than its count.
 *
 * A bare name matching several symbols comes back `found: false` with the
 * candidate qnames in `candidates`, so the caller can pick one and ask again
 * rather than concluding the symbol does not exist.
 */
import type { GraphDb } from '../db.ts'
import { num, type SqlRow, str } from '../row.ts'
import { estimateTokens, fitRows } from './budget.ts'
import { resolveSymbol } from './resolve.ts'

export interface RelationEdge {
  kind: string
  src: string
  dst: string
  line: number
  resolved: number
  confidence: number
}

export interface RelationsMetadata {
  kind: string | null
  path: string | null
  line: number | null
  exported: boolean
}

/**
 * Which side of the symbol each section reads, and the edge kind it carries.
 *
 * This is the single list of relation keys: `RelationSections`,
 * `RelationCounts`, `emptySections` and `zeroCounts` all derive from it, so a
 * new relation is one row here and nothing else.
 */
const SECTIONS = [
  ['callers', 'dst', 'CALLS'],
  ['callees', 'src', 'CALLS'],
  ['imports', 'src', 'IMPORTS'],
  ['inheritedBy', 'dst', 'INHERITS'],
  ['inheritsFrom', 'src', 'INHERITS'],
  ['implements', 'src', 'IMPLEMENTS'],
  ['implementedBy', 'dst', 'IMPLEMENTS'],
  ['testedBy', 'dst', 'TESTED_BY'],
  ['references', 'dst', 'REFERENCES'],
  ['contains', 'src', 'CONTAINS'],
] as const satisfies ReadonlyArray<readonly [string, 'src' | 'dst', string]>

/** One relation section name, as listed in `SECTIONS`. */
export type SectionKey = (typeof SECTIONS)[number][0]

export type RelationSections = Record<SectionKey, RelationEdge[]>

/** True edge count per section, before the SQL cap or the token budget. */
export type RelationCounts = Record<SectionKey, number>

export interface RelationsResult {
  symbol: string
  found: boolean
  relations: RelationSections
  /**
   * Total edges that exist per section, independent of how many are returned.
   * A count larger than the returned array means the section was cut.
   */
  counts: RelationCounts
  metadata: RelationsMetadata
  /**
   * Candidate qnames when `symbol` was a bare name matching several symbols.
   * Non-empty only with `found: false`, and it means *ambiguous*, not absent:
   * re-ask with one of these qnames. Empty in every other case.
   */
  candidates: string[]
  /**
   * Whether any relation section returned fewer rows than its count — because
   * of the per-relation cap, the token budget, or both.
   */
  truncated: boolean
}

const MAX_PER_RELATION = 30

// `Object.fromEntries` is typed as `Record<string, T>`, so both need the cast;
// `SECTIONS` supplies exactly the keys the target types are built from.
function emptySections(): RelationSections {
  const entries = SECTIONS.map(([key]) => [key, []] as [SectionKey, RelationEdge[]])
  return Object.fromEntries(entries) as RelationSections
}

function zeroCounts(): RelationCounts {
  const entries = SECTIONS.map(([key]) => [key, 0] as [SectionKey, number])
  return Object.fromEntries(entries) as RelationCounts
}

/**
 * Fetch edges for one relation kind, scoped to one side of the symbol.
 *
 * The row count is capped, so the total is counted separately: a caller that
 * only sees the capped rows cannot tell a complete section from a cut one.
 * @param db - the open graph database.
 * @param field - which side of the edge the symbol sits on.
 * @param qname - the symbol's qname.
 * @param kind - the edge kind to fetch.
 * @param limit - maximum rows to return.
 * @returns The capped rows plus the true edge count.
 */
function queryEdges(
  db: GraphDb,
  field: 'src' | 'dst',
  qname: string,
  kind: string,
  limit: number = MAX_PER_RELATION,
): { rows: RelationEdge[]; total: number } {
  const total = Number(
    (db.db
      .prepare(`SELECT COUNT(*) AS n FROM edges WHERE ${field} = ? AND kind = ?`)
      .get(qname, kind) as { n?: number } | undefined)?.n ?? 0,
  )

  if (total === 0) return { rows: [], total: 0 }

  const rows = db.db
    .prepare(
      `SELECT kind, src, dst, path, line, resolved, confidence FROM edges
       WHERE ${field} = ? AND kind = ?
       ORDER BY confidence DESC, line ASC
       LIMIT ?`,
    )
    .all(qname, kind, limit) as SqlRow[]

  return {
    total,
    rows: rows.map((r) => ({
      kind: str(r, 'kind'),
      src: str(r, 'src'),
      dst: str(r, 'dst'),
      line: num(r, 'line'),
      resolved: num(r, 'resolved'),
      confidence: num(r, 'confidence'),
    })),
  }
}

/**
 * Get all structural relations for a symbol.
 *
 * The `query` can be a bare name, a file path, or a full qname. A bare name
 * matching several symbols returns `found: false` with those qnames in
 * `candidates`.
 * @param db - the open graph database.
 * @param query - symbol name or qname.
 * @param budget - token budget for the result.
 * @returns Relations grouped by kind with metadata.
 */
export function getRelations(db: GraphDb, query: string, budget: number): RelationsResult {
  const hit = resolveSymbol(db, query)

  if (hit.status !== 'resolved') {
    return {
      symbol: query,
      found: false,
      relations: emptySections(),
      counts: zeroCounts(),
      metadata: { kind: null, path: null, line: null, exported: false },
      candidates: hit.status === 'ambiguous' ? hit.candidates : [],
      truncated: false,
    }
  }
  const qname = hit.qname

  // Fetch all relation types in a single transaction.
  const edges = emptySections()
  const counts = zeroCounts()
  db.transaction(() => {
    for (const [key, field, kind] of SECTIONS) {
      const section = queryEdges(db, field, qname, kind)
      edges[key] = section.rows
      counts[key] = section.total
    }
  })

  // Metadata
  const metaRow = db.db
    .prepare("SELECT kind, path, line_start, exported FROM nodes WHERE qname = ?")
    .get(qname) as { kind?: string; path?: string; line_start?: number; exported?: number } | undefined

  const metadata: RelationsMetadata = {
    kind: metaRow?.kind ?? null,
    path: metaRow?.path ?? null,
    line: metaRow?.line_start ?? null,
    exported: (metaRow?.exported ?? 0) === 1,
  }

  // Build the flat result, then budget-wrap each section.
  // Compute the fixed envelope cost from the actual shape we return.
  const envelope = {
    symbol: query, found: true, metadata, counts, candidates: [], truncated: false, relations: {},
  }
  const overhead = estimateTokens(envelope)

  // Per-section budget: divide remaining budget across sections that have data.
  const activeSections = SECTIONS.filter(([key]) => edges[key].length > 0)
  const perSectionBudget = activeSections.length > 0
    ? Math.floor((budget - overhead) / activeSections.length)
    : budget

  const relations = emptySections()
  let anyTruncated = false
  for (const [key] of SECTIONS) {
    const rows = edges[key]
    if (rows.length === 0) continue
    const fitted = fitRows(rows, perSectionBudget, 40) // 40 for section header overhead
    relations[key] = fitted.rows
    // Honest on both counts: the SQL cap drops rows before fitRows ever sees
    // them, so compare against the true total rather than against `rows`.
    if (fitted.rows.length < counts[key]) anyTruncated = true
  }

  return {
    symbol: query,
    found: true,
    relations,
    counts,
    metadata,
    candidates: [],
    truncated: anyTruncated,
  }
}
