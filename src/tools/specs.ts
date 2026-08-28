/**
 * The four graph-backed tools, as data.
 *
 * A spec is the per-tool half of a registration: its wire name, the description
 * the model reads, its parameter schema, the guards that must run before the
 * (possibly slow) index acquire, the query call, and its card title. The other
 * half — the shared envelope, the budget clamp, the acquire, the freshness
 * record — lives in `src/index.ts`, because that half is what makes "every
 * result reports freshness" a property of registration rather than of
 * copy-paste.
 *
 * They live here rather than inline at the registration site so that something
 * other than Cordis can read them. Two callers need that: the benchmark harness
 * measures the token cost of these schemas (they are injected into every
 * session before any work happens) and calls `run` to measure real tool output.
 * A transcribed copy would drift, and a drifting copy would quietly falsify
 * every number measured against it.
 */
import type { InferArgs, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { GraphDb } from '../db.ts'
import type { ToolName } from '../config.ts'
import { findSymbols } from '../query/find.ts'
import { overview } from '../query/overview.ts'
import { getRelations } from '../query/relations.ts'
import { computeImpact } from '../query/impact.ts'
import { requireNonEmpty, requirePaths } from './args.ts'

/**
 * What `max_tokens` means, in terms that survive a settings change.
 *
 * Deliberately free of numbers: the default and the ceiling are user
 * configuration now, and a tool description is part of the prompt prefix, so
 * restating them here would invalidate a conversation's KV cache every time
 * someone edited the section.
 */
export const BUDGET_DESCRIPTION =
  'Token budget for the result. Omit for the configured default; a larger request is clamped '
  + 'to the configured ceiling. Every result reports the budget it actually ran under.'

/** The per-tool half of a registration. */
export interface GraphToolSpec<S extends ParameterSchemaSpec = ParameterSchemaSpec> {
  name: ToolName
  description: string
  parameters: S
  /** Argument guards; run before acquiring so bad input fails fast. */
  check?: (args: InferArgs<S>) => void
  /** The actual query. Its result is returned as-is plus `freshness`. */
  run: (db: GraphDb, args: InferArgs<S>, budget: number) => object
  /** Pending-card title. */
  title: (args: InferArgs<S>) => string
}

/**
 * Identity, for the inference only.
 *
 * `const S` captures each parameter schema as literal types, which is what
 * makes `args` inside `check` / `run` / `title` know its own fields. Annotating
 * the consts with `GraphToolSpec` directly would widen `S` and lose that.
 * @param spec - the spec to type.
 * @returns the same spec, with `S` inferred.
 */
const defineGraphTool = <const S extends ParameterSchemaSpec>(spec: GraphToolSpec<S>): GraphToolSpec<S> => spec

export const codeOverviewSpec = defineGraphTool({
  name: 'code_overview',
  description:
    'Cheap structural orientation for the current repository: size, languages, module layout, '
    + 'most-called symbols, and entry points. Call this FIRST when exploring an unfamiliar codebase — '
    + 'it costs a few hundred tokens and tells you where to look next. Pass `focus` with a directory '
    + 'to get the same summary scoped to one area — a directory only, not a file or a symbol; either '
    + 'comes back with `status: "empty"`. Reports index freshness so you know the data is current.',
  parameters: {
    focus: {
      type: 'string',
      description: 'Optional directory path to scope the summary to (e.g. "src/parser"). '
        + 'Directories only — a file path or symbol name matches nothing and returns `status: "empty"`.',
    },
    max_tokens: {
      type: 'number',
      description: BUDGET_DESCRIPTION,
    },
  },
  run: (db, args, budget) => overview(db, args.focus, budget),
  title: (args) => (args.focus ? `code overview: ${args.focus}` : 'code overview'),
})

export const codeFindSpec = defineGraphTool({
  name: 'code_find',
  description:
    'Find symbols (functions, classes, methods, interfaces, types) by name across the repository, '
    + 'returning each one\'s exact file, line, and signature — WITHOUT reading file contents. '
    + 'Use this instead of grep+read when you are looking for where something is defined. '
    + 'Each hit reports how many symbols call it, so you can tell central code from incidental code. '
    + 'Then use the returned path and line with the `read` tool if you need the body.',
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Symbol name or partial name to search for.',
    },
    kind: {
      type: 'string',
      description: 'Restrict to one kind: function, method, class, interface, type, enum, var.',
    },
    path_glob: {
      type: 'string',
      description: 'Restrict to matching paths, e.g. "packages/core/*".',
    },
    limit: { type: 'number', description: 'Maximum hits to consider (default 40).' },
    max_tokens: { type: 'number', description: BUDGET_DESCRIPTION },
  },
  check: (args) => requireNonEmpty('query', args.query),
  run: (db, args, budget) => {
    const found = findSymbols(db, {
      query: args.query,
      kind: args.kind,
      pathGlob: args.path_glob,
      limit: args.limit,
      budget,
    })
    return {
      hits: found.rows,
      total: found.total,
      truncated: found.truncated,
      budget: { used: found.used, limit: budget },
    }
  },
  title: (args) => `code find: ${args.query}`,
})

export const codeRelationsSpec = defineGraphTool({
  name: 'code_relations',
  description:
    'Show all structural relations of a symbol: callers, callees, imports, inheritance '
    + '(inheritsFrom / inheritedBy), implementations (implements / implementedBy), tests, and references. '
    + 'Use after code_overview to drill into a '
    + 'specific symbol — the `hubs` section lists the most-called symbols. Results include '
    + 'confidence scores so you know which edges are real. At most 30 edges come back per '
    + 'relation; `counts` reports the true total for each, so you can tell a complete answer '
    + 'from a capped one. A bare name matching several symbols returns found=false with the '
    + 'matching qnames in `candidates` — pick one and ask again, the symbol does exist.',
  parameters: {
    symbol: {
      type: 'string',
      required: true,
      description: 'Symbol name or qname (e.g. "Service", "src/service.ts::Service.run").',
    },
    max_tokens: {
      type: 'number',
      description: BUDGET_DESCRIPTION,
    },
  },
  check: (args) => requireNonEmpty('symbol', args.symbol),
  run: (db, args, budget) => getRelations(db, args.symbol, budget),
  title: (args) => `code relations: ${args.symbol}`,
})

export const codeImpactSpec = defineGraphTool({
  name: 'code_impact',
  description:
    'Show what would be affected by a change to one or more files or symbols. '
    + 'Traces reverse dependencies (who calls/imports/inherits from the target) up to '
    + 'a configurable depth. A file path covers everything declared in that file, so '
    + 'callers of its functions are included, not just files that import it. Use before '
    + 'editing to scope your test plan and spot breaking changes. Targets that matched '
    + 'nothing come back in `unresolved`; a bare name matching several symbols comes back in '
    + '`ambiguous` with its candidate qnames, which is not the same as absent.',
  parameters: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      required: true,
      description: 'Paths or symbol names to analyse (e.g. ["src/service.ts", "src/util.ts::helper"]).',
    },
    max_depth: {
      type: 'number',
      description: 'Max BFS depth (default 3, max 5). Higher = more thorough but costlier.',
    },
    max_tokens: {
      type: 'number',
      description: BUDGET_DESCRIPTION,
    },
  },
  check: (args) => requirePaths(args.paths),
  run: (db, args, budget) => {
    const maxDepth = Math.min(5, Math.max(1, Math.floor(args.max_depth ?? 3)))
    return computeImpact(db, args.paths, maxDepth, budget)
  },
  title: (args) => `code impact: ${args.paths.join(', ')}`,
})

/**
 * Every tool this plugin registers, in registration order.
 *
 * Registration itself does not read this array — `src/index.ts` names all four
 * specs individually, because a loop over a heterogeneous tuple would widen
 * every parameter schema back to `ParameterSchemaSpec`. It exists so a caller
 * that only wants the schemas (their names, descriptions and shapes) can have
 * them without the type-level ceremony.
 */
export const graphToolSpecs: readonly GraphToolSpec[] = [
  codeOverviewSpec,
  codeFindSpec,
  codeRelationsSpec,
  codeImpactSpec,
] as readonly GraphToolSpec[]
