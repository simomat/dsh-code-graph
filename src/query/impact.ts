/**
 * Transitive dependency analysis — `code_impact`.
 *
 * Given one or more paths or symbol qnames, computes all symbols that depend
 * on them (reverse CALLS, IMPORTS, INHERITS, IMPLEMENTS, TESTED_BY, REFERENCES
 * edges) up to a configurable BFS depth.
 *
 * A file target stands for everything it contains: reverse edges into a file
 * node are IMPORTS only, so the file's symbols are seeded alongside it at
 * depth 0 — otherwise callers of those symbols would never be reached.
 *
 * Uses one bulk query per BFS layer for all reverse edges, then processes in
 * JavaScript to track depth and deduplicate. Every `IN` list is chunked: the
 * frontier and the visited set are bounded only by the size of the graph, and
 * a list past `SQLITE_MAX_VARIABLE_NUMBER` fails the whole tool call.
 */
import type { GraphDb } from '../db.ts'
import { num, type SqlRow, str } from '../row.ts'
import { estimateTokens, fitRows } from './budget.ts'
import { type AmbiguousTarget, resolveTargets } from './resolve.ts'
import { chunked } from './sql.ts'

export interface ImpactNode {
  qname: string
  kind: string
  name: string
  path: string
  line: number
  /** 0 = directly targeted, 1 = one hop away, etc. */
  depth: number
  /**
   * Edge kind connecting this node to its parent in the BFS tree. Seeds use
   * `target` (named directly) or `target-member` (contained by a targeted file).
   */
  relation: string
  /** Confidence of the edge that reached this node. */
  confidence: number
}

export interface ImpactResult {
  paths: string[]
  affected: ImpactNode[]
  /** Total distinct symbols in the result (including targets). */
  totalAffected: number
  /** Maximum depth reached. */
  maxDepth: number
  /** Targets with no match at all in the index. */
  unresolved: string[]
  /**
   * Targets that matched several symbols, with the qnames to choose from.
   * Distinct from `unresolved`: the symbol exists, the name just did not say
   * which one. Re-run with a qname from `candidates` to include it.
   */
  ambiguous: AmbiguousTarget[]
  /** Whether the BFS was truncated because a layer exceeded its edge cap. */
  truncated: boolean
}

const MAX_DEPTH = 5
const MAX_PER_LAYER = 100

/**
 * Expand the resolved targets into the BFS seed set.
 *
 * A file node's only reverse edges are IMPORTS, and CONTAINS points down
 * (`src` = parent), so a file target alone reaches importing files and nothing
 * else. Every symbol declared in a targeted file is therefore seeded too, at
 * depth 0 — a change to the file is a change to all of them.
 *
 * @param db - the open graph database.
 * @param resolved - qnames the targets resolved to.
 * @returns Seeds in resolution order, files followed by their members.
 */
function seedTargets(
  db: GraphDb,
  resolved: string[],
): Array<{ qname: string; relation: string }> {
  const seeds: Array<{ qname: string; relation: string }> = resolved.map((qname) => ({
    qname,
    relation: 'target',
  }))

  const filePaths: string[] = []
  for (const batch of chunked(resolved)) {
    const placeholders = batch.map(() => '?').join(',')
    const rows = db.db
      .prepare(`SELECT path FROM nodes WHERE kind = 'file' AND qname IN (${placeholders})`)
      .all(...(batch as never[])) as Array<{ path: string }>
    for (const r of rows) filePaths.push(r.path)
  }

  if (filePaths.length === 0) return seeds

  for (const batch of chunked(filePaths)) {
    const placeholders = batch.map(() => '?').join(',')
    const members = db.db
      .prepare(`SELECT qname FROM nodes WHERE kind != 'file' AND path IN (${placeholders})`)
      .all(...(batch as never[])) as Array<{ qname: string }>
    for (const m of members) seeds.push({ qname: m.qname, relation: 'target-member' })
  }
  return seeds
}

/**
 * Compute transitive reverse dependencies for a set of target qnames.
 *
 * BFS through reverse edges: CALLS, IMPORTS, INHERITS, IMPLEMENTS, TESTED_BY,
 * REFERENCES. Each layer is a single SQL query over all active frontier qnames.
 *
 * @param db - the open graph database.
 * @param targets - resolved qnames to start from.
 * @param maxDepth - maximum BFS depth (1..5).
 * @param budget - token budget for the result.
 * @returns Impact analysis with depth info.
 */
export function computeImpact(
  db: GraphDb,
  targets: string[],
  maxDepth: number,
  budget: number,
): ImpactResult {
  const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(maxDepth)))

  // Resolve queries to qnames.
  const { resolved, unresolved, ambiguous } = resolveTargets(db, targets)

  if (resolved.length === 0) {
    return {
      paths: targets,
      affected: [],
      totalAffected: 0,
      maxDepth: 0,
      unresolved,
      ambiguous,
      truncated: false,
    }
  }

  // BFS state: qname -> { depth, relation, confidence }
  // First arrival wins: a node is recorded with the shallowest depth that
  // reaches it, and among the edges in that layer with the first one the layer
  // query returns — deterministic, ordered by `e.dst, e.kind, n.line_start`.
  // `relation` and `confidence` therefore describe that edge, not the strongest
  // one; depth is what impact analysis ranks on, and depth is exact.
  const visited = new Map<string, { depth: number; relation: string; confidence: number }>()
  for (const seed of seedTargets(db, resolved)) {
    if (visited.has(seed.qname)) continue
    visited.set(seed.qname, { depth: 0, relation: seed.relation, confidence: 1 })
  }

  let frontier = [...visited.keys()]
  let currentDepth = 0
  let truncated = false

  // Reverse-edge kinds to trace — includes REFERENCES for completeness.
  const edgeKinds = ['CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'TESTED_BY', 'REFERENCES', 'CONTAINS']
  const kindsClause = edgeKinds.map(() => '?').join(',')

  while (currentDepth < depth && frontier.length > 0) {
    currentDepth += 1

    // Bulk-fetch all reverse edges from the frontier, one statement per chunk
    // so a frontier wider than the parameter limit still runs. The per-chunk
    // cap keeps the layer's total budget at MAX_PER_LAYER * frontier.length.
    const rows: SqlRow[] = []
    for (const batch of chunked(frontier)) {
      const placeholders = batch.map(() => '?').join(',')
      const cap = MAX_PER_LAYER * batch.length
      const sql = `
        SELECT e.src, e.dst, e.kind AS edge_kind, e.resolved, e.confidence,
               n.name, n.kind AS node_kind, n.path, n.line_start
        FROM edges e
        JOIN nodes n ON n.qname = e.src
        WHERE e.dst IN (${placeholders})
          AND e.kind IN (${kindsClause})
        ORDER BY e.dst, e.kind, n.line_start
        LIMIT ?
      `
      const params: unknown[] = [...batch, ...edgeKinds, cap]
      const batchRows = db.db
        .prepare(sql)
        .all(...(params as never[])) as SqlRow[]

      // Hitting the cap means edges may have been silently dropped.
      if (batchRows.length >= cap) truncated = true
      for (const r of batchRows) rows.push(r)
    }

    const nextFrontier: string[] = []
    for (const r of rows) {
      const srcQname = str(r, 'src')
      if (visited.has(srcQname)) continue

      visited.set(srcQname, {
        depth: currentDepth,
        relation: str(r, 'edge_kind'),
        confidence: num(r, 'confidence'),
      })
      nextFrontier.push(srcQname)
    }

    frontier = nextFrontier
  }

  // Batch-fetch metadata for every visited qname, chunked: `visited` is bounded
  // only by the node count, which on a large repo exceeds the parameter limit.
  type NodeRow = { qname: string; kind: string; name: string; path: string; line_start: number }
  const nodeMap = new Map<string, NodeRow>()
  for (const batch of chunked([...visited.keys()])) {
    const placeholders = batch.map(() => '?').join(',')
    const nodeRows = db.db
      .prepare(`SELECT qname, kind, name, path, line_start FROM nodes WHERE qname IN (${placeholders})`)
      .all(...(batch as never[])) as NodeRow[]
    for (const row of nodeRows) nodeMap.set(row.qname, row)
  }

  // Build the affected list from visited set + batched metadata.
  const affected: ImpactNode[] = []
  for (const [qname, info] of visited) {
    const nodeRow = nodeMap.get(qname)
    if (!nodeRow) continue

    affected.push({
      qname,
      kind: nodeRow.kind,
      name: nodeRow.name,
      path: nodeRow.path,
      line: nodeRow.line_start ?? 0,
      depth: info.depth,
      relation: info.relation,
      confidence: info.confidence,
    })
  }

  // Sort: depth first, then path + line for stability.
  affected.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth
    if (a.path !== b.path) return a.path.localeCompare(b.path)
    return a.line - b.line
  })

  // Budget-wrap: keep highest-value rows (shallowest depth first, already sorted).
  // Compute the fixed envelope cost from the actual shape we return.
  const envelope = {
    paths: targets, affected: [], totalAffected: affected.length,
    maxDepth: currentDepth, unresolved, ambiguous, truncated: false,
  }
  const overhead = estimateTokens(envelope)
  const fitted = fitRows(affected, budget, overhead)

  return {
    paths: targets,
    affected: fitted.rows,
    totalAffected: affected.length,
    maxDepth: currentDepth,
    unresolved,
    ambiguous,
    truncated: truncated || fitted.truncated,
  }
}
