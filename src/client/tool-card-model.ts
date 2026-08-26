/**
 * What one graph tool call looks like, read off the frozen conversation block.
 *
 * The tool's canonical result never reaches the browser, so everything here
 * comes from `meta` — the projection the host half wrote through
 * `presentationMeta` — plus the block's own lifecycle. Both are read
 * defensively: a call from an older build of this plugin, a Code-Mode
 * sub-dispatch (which carries no meta at all), and a truncated event window all
 * arrive here as an ordinary block with less in it.
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/** The conversation block, running or settled. */
type Block = ToolCallViewProps['block']

/** Lifecycle of the call itself, independent of what the index answered. */
export type CallState = 'running' | 'ok' | 'error' | 'stopped'

/** What the row renders. */
export interface ToolCard {
  /** Call lifecycle. */
  state: CallState
  /** Index state as of this call, when the result said. */
  index?: 'ready' | 'stale' | 'building' | 'unavailable'
  /** Build progress, while one was running. */
  progress?: { parsed: number; total: number; phase: string }
  /** How current the answer was. */
  freshness?: { dirtyFiles: number; builtAt: number | null }
  /** Repository size, on `code_overview` only. */
  totals?: { files: number; symbols: number; edges: number; tests: number }
  /** Indexed languages by file count, on `code_overview` only. */
  languages?: Array<{ lang: string; files: number }>
  /** The first argument worth naming in the row title. */
  subject: string | null
}

/** Read one property off a value that may be anything at all. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

/** Narrow to a finite number, or undefined. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The argument a person would recognize the call by. */
function subjectOf(argsRaw: string): string | null {
  try {
    const args = JSON.parse(argsRaw) as unknown
    for (const key of ['query', 'symbol', 'focus']) {
      const value = field(args, key)
      if (typeof value === 'string' && value.length > 0) return value
    }
    const paths = field(args, 'paths')
    if (Array.isArray(paths)) {
      const named = paths.filter((p): p is string => typeof p === 'string')
      if (named.length > 0) return named.join(', ')
    }
    return null
  } catch {
    // A half-streamed or truncated argument string is not a failure to report;
    // the row simply has no subject to name.
    return null
  }
}

/**
 * Project one block into the row's model.
 * @param block - the frozen call or result node.
 * @returns Everything the row draws.
 */
export function toolCard(block: Block): ToolCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: CallState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'

  const card: ToolCard = { state, subject: subjectOf(argsRaw) }
  if (!settled || block.isError) return card

  const meta = block.meta
  const status = field(meta, 'status')
  if (status === 'ready' || status === 'stale' || status === 'building' || status === 'unavailable') {
    card.index = status
  }

  const progress = field(meta, 'progress')
  if (progress !== undefined) {
    card.progress = {
      parsed: num(field(progress, 'parsed')) ?? 0,
      total: num(field(progress, 'total')) ?? 0,
      phase: typeof field(progress, 'phase') === 'string' ? field(progress, 'phase') as string : 'scanning',
    }
  }

  const freshness = field(meta, 'freshness')
  if (freshness !== undefined) {
    card.freshness = {
      dirtyFiles: num(field(freshness, 'dirtyFiles')) ?? 0,
      builtAt: num(field(freshness, 'builtAt')) ?? null,
    }
  }

  const totals = field(meta, 'totals')
  if (totals !== undefined) {
    card.totals = {
      files: num(field(totals, 'files')) ?? 0,
      symbols: num(field(totals, 'symbols')) ?? 0,
      edges: num(field(totals, 'edges')) ?? 0,
      tests: num(field(totals, 'tests')) ?? 0,
    }
  }

  const languages = field(meta, 'languages')
  if (Array.isArray(languages)) {
    card.languages = languages.flatMap((entry) => {
      const lang = field(entry, 'lang')
      return typeof lang === 'string' ? [{ lang, files: num(field(entry, 'files')) ?? 0 }] : []
    })
  }

  return card
}
