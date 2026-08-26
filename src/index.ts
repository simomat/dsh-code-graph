/**
 * dsh-code-graph — structural code access for the DeepSeek Harness.
 *
 * Registers a small set of model-facing tools backed by a locally built
 * code graph, so exploring a codebase costs a handful of cheap structured
 * calls instead of a read/grep/glob loop over whole files.
 *
 * Everything is in-process: parsing uses WASM tree-sitter, storage uses the
 * built-in `node:sqlite`, and the only external dependency is `git` for file
 * enumeration (with a directory-walk fallback when it is unavailable).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'
import { defineTool, type InferArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { GraphDb, graphDbPath } from './db.ts'
import {
  assertServiceableConfig,
  CODE_GRAPH_NS,
  type CodeGraphConfig,
  invalidatesIndex,
  type ToolName,
} from './config.ts'
import { CodeGraphConfigSchema } from './settings.ts'
import { indexLimits } from './index/build.ts'
import { disposeGrammars } from './parse/loader.ts'
import { disposeQueries } from './parse/query-extract.ts'
import { clearResolverConfigCache } from './parse/imports/config.ts'
import { clampBudget } from './query/budget.ts'
import { findSymbols } from './query/find.ts'
import { overview } from './query/overview.ts'
import { getRelations } from './query/relations.ts'
import { computeImpact } from './query/impact.ts'
import { IndexManager } from './index/manager.ts'
import { requireNonEmpty, requirePaths } from './tools/args.ts'
import { cardMeta } from './tools/present.ts'

export const name = 'dsh-code-graph'
export const inject = ['tools']

/** Composition-entry schema; also the user-editable settings section. */
export const Config: z<CodeGraphConfig> = CodeGraphConfigSchema

/** Resolve the DSH home directory the same way the harness itself does. */
function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/**
 * Plugin entry point.
 * @param ctx - the Cordis context supplying the tool registry.
 * @param config - the composed entry config, layered under the user document.
 */
export function apply(ctx: Context, config: CodeGraphConfig): void {
  assertServiceableConfig(config)
  // The authoritative section: the resolved settings scope while a provider is
  // attached, the composition entry otherwise. Read through a thunk on every
  // use, so nothing downstream holds a copy a commit could leave stale.
  let source: () => CodeGraphConfig = () => config
  const current = (): CodeGraphConfig => source()

  const manager = new IndexManager({
    // Resolved per call rather than captured: an `indexDir` change lands here
    // on the next acquire, and `reset()` has already dropped whatever was open
    // under the old path.
    resolveDbPath: (repoRoot) => graphDbPath(current().indexDir ?? dshHome(), repoRoot),
    open: (dbPath, repoRoot) => GraphDb.open(dbPath, repoRoot),
    limits: () => indexLimits(current()),
  })

  // A settings provider is optional: `installSettingsSection` registers only if
  // the deployment mounted one, and falls back to the composition entry when it
  // detaches. A headless profile without settings keeps working as composed.
  let inForce = config
  installSettingsSection(ctx, settingsNamespace(CODE_GRAPH_NS), Config, config, {
    validate: assertServiceableConfig,
    setSource: (next) => { source = next },
    onChange: () => {
      const next = current()
      // Budgets are read per tool call, so only a change to what belongs in the
      // index costs anything, and there the honest answer is to forget the
      // databases and let the next call rebuild them.
      if (invalidatesIndex(next, inForce)) manager.reset()
      inForce = next
    },
  })

  // One effect owns every resource: databases, cached grammars, and the
  // background build. Disposing the fiber unwinds all of it.
  ctx.effect(() => () => {
    manager.dispose()
    disposeGrammars()
    disposeQueries()
    clearResolverConfigCache()
  })

  // Keep the index honest about edits the agent itself performs, including
  // deletes (`kind` other than `present`). Without that, a deleted file stays
  // in the graph until some unrelated edit forces a refresh.
  //
  // `fs/observed` is declared by `@deepseek-ai/dsh-fs`, which this plugin does
  // not depend on: the event carries only a path and this plugin should still
  // load in a composition without the filesystem stack. So the subscription is
  // untyped and defensive rather than a hard dependency.
  //
  // The listener must stay synchronous — a throw here fails the observing tool
  // call and a returned promise is not awaited — so it only marks the path
  // dirty; re-parsing happens later, on the next query.
  const onObserved = (target: unknown, _observation: unknown): void => {
    const displayPath = (target as { displayPath?: unknown } | undefined)?.displayPath
    if (typeof displayPath === 'string') manager.markDirty(displayPath)
  }
  const events = ctx as unknown as {
    on(event: string, listener: (...args: never[]) => void): (() => void) | undefined
  }
  events.on('fs/observed', onObserved as (...args: never[]) => void)

  /**
   * What `max_tokens` means, in terms that survive a settings change.
   *
   * Deliberately free of numbers: the default and the ceiling are user
   * configuration now, and a tool description is part of the prompt prefix, so
   * restating them here would invalidate a conversation's KV cache every time
   * someone edited the section. Every result reports `budget.limit`, which is
   * the honest answer and costs the model one call to learn.
   */
  const BUDGET_DESCRIPTION =
    'Token budget for the result. Omit for the configured default; a larger request is clamped '
    + 'to the configured ceiling. Every result reports the budget it actually ran under.'

  /**
   * Register one graph-backed tool.
   *
   * All four tools share the same envelope: an open JSON object result, no
   * parallel siblings, a clamped token budget, one index acquisition, and the
   * freshness record spread onto the result. Keeping that here is what makes
   * "every result reports freshness" — promised by the README and by all four
   * tool descriptions — a property of registration rather than of copy-paste.
   *
   * A tool contributes only its schema, the guards that must run before the
   * (possibly slow) acquire, the query call, and its card title.
   * @param spec - the per-tool half of a registration.
   */
  const registerGraphTool = <const S extends ParameterSchemaSpec>(spec: {
    name: ToolName
    description: string
    parameters: S
    /** Argument guards; run before acquiring so bad input fails fast. */
    check?: (args: InferArgs<S>) => void
    /** The actual query. Its result is returned as-is plus `freshness`. */
    run: (db: GraphDb, args: InferArgs<S>, budget: number) => object
    /** Pending-card title. */
    title: (args: InferArgs<S>) => string
  }): void => {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        // The canonical value never leaves the host, so anything a card needs
        // has to be projected here. Pure and replayable, as the contract
        // requires: it reads the value and nothing else.
        presentationMeta: (_args, value) => cardMeta(value),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        spec.check?.(args)
        // `S` is still generic here, so the `max_tokens` property every caller
        // declares is not visible on `args`; the cast is that, not a claim.
        const budget = clampBudget((args as { max_tokens?: number }).max_tokens, current())
        const handle = await manager.acquire(exec, { signal: exec.signal })
        if (handle.status !== 'ready') return handle.notReady
        // The declared schema is an open object and `run` returns the tool's
        // own shape, which the inferred value type cannot express.
        return { ...spec.run(handle.db, args, budget), freshness: handle.freshness } as never
      },
      presentCall: (args) => ({ card: 'generic', kind: 'search', title: spec.title(args) }),
    }))
  }

  registerGraphTool({
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

  registerGraphTool({
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

  registerGraphTool({
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

  registerGraphTool({
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
}
