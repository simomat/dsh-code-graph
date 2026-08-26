/**
 * Browser half: the plugin's surfaces on the web UI.
 *
 * Everything crossing to another plugin is a type-only import. A value import
 * of another plugin's package either inlines a second copy of its runtime or
 * asks the loader's module table for a specifier it cannot answer; the harness
 * catches that at build time for its own packages and nothing catches it here.
 * Collaboration goes through cordis services and slots instead.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the `ctx.settingsScope` Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `settings.plugin.item` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pulls the `tool.call.toolview` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { CODE_GRAPH_NS, type CodeGraphConfig, TOOL_NAMES } from '../config.ts'
import { CodeGraphCard } from './CodeGraphCard.tsx'
import { CodeGraphCardController } from './settings-controller.ts'
import { ToolCard } from './ToolCard.tsx'

/**
 * Services this half needs before it can register anything.
 *
 * Kept to exactly what is used: web boot is all-or-nothing, so an entry left
 * waiting on a service some deployment does not provide would take the whole UI
 * down rather than just dropping this card.
 */
export const inject = ['slots', 'settingsScope']

/**
 * Browser-half entry point.
 * @param ctx - the client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  const card = new CodeGraphCardController(
    ctx.settingsScope.bind<CodeGraphConfig>({ namespace: CODE_GRAPH_NS }),
  )
  ctx.effect(() => card.start(), 'dsh-code-graph: settings card')

  // The slot belongs to the plugin configuration tab, which may not have
  // declared it yet (or may redeclare it). `inject` waits for the declaration
  // and re-registers across one, instead of racing it.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    // The settings namespace is the join key: the tab pairs this card with the
    // Host section of the same name without knowing what either means.
    key: CODE_GRAPH_NS,
    inject: () => card.inject(),
  }, CodeGraphCard))

  // One component for all four tools, keyed by wire tool name. The generator
  // form installs them as one transaction and disposes them in reverse; a name
  // nothing registers simply keeps the generic card.
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const tool of TOOL_NAMES) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: tool }, ToolCard)
    }
  })
}
