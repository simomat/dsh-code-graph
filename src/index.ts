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
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { GraphDb, graphDbPath } from './db.ts'
import {
  assertServiceableConfig,
  CODE_GRAPH_NS,
  type CodeGraphConfig,
  invalidatesIndex,
} from './config.ts'
import { CodeGraphConfigSchema } from './settings.ts'
import { indexLimits } from './index/build.ts'
import { disposeGrammars } from './parse/loader.ts'
import { disposeQueries } from './parse/query-extract.ts'
import { clearResolverConfigCache } from './parse/imports/config.ts'
import { clampBudget } from './query/budget.ts'
import { IndexManager } from './index/manager.ts'
import {
  codeFindSpec,
  codeImpactSpec,
  codeOverviewSpec,
  codeRelationsSpec,
  type GraphToolSpec,
} from './tools/specs.ts'
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
   * Register one graph-backed tool.
   *
   * All four tools share the same envelope: an open JSON object result, no
   * parallel siblings, a clamped token budget, one index acquisition, and the
   * freshness record spread onto the result. Keeping that here is what makes
   * "every result reports freshness" — promised by the README and by all four
   * tool descriptions — a property of registration rather than of copy-paste.
   *
   * The other half of a registration — schema, guards, query call, card title —
   * is a `GraphToolSpec` in `src/tools/specs.ts`.
   * @param spec - the per-tool half of a registration.
   */
  const registerGraphTool = <const S extends ParameterSchemaSpec>(spec: GraphToolSpec<S>): void => {
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

  // Named individually rather than looped over `graphToolSpecs`: a loop widens
  // every parameter schema back to `ParameterSchemaSpec`, and with it the
  // `args` each spec's own callbacks see.
  registerGraphTool(codeOverviewSpec)
  registerGraphTool(codeFindSpec)
  registerGraphTool(codeRelationsSpec)
  registerGraphTool(codeImpactSpec)
}
