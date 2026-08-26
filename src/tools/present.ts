/**
 * What a browser card is allowed to see.
 *
 * A tool's canonical return value is execution-local: the harness persists the
 * rendered content, not the object the tool produced, so a UI cannot read the
 * result shape back. `presentationMeta` is the sanctioned channel — a small,
 * pure, JSON-serializable projection stored alongside the result and replayed
 * with it. This module owns that projection for all four graph tools, which is
 * why it lives beside them rather than inside any one of them.
 *
 * Deliberately narrow: everything here is derived from a value the tool already
 * returned, so a card can render index state without a second wire and without
 * this plugin promising anything about the rest of the result.
 */
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Index state a card renders, projected from one tool result. */
export interface CodeGraphCardMeta {
  /** Index state as of this call. */
  status: 'ready' | 'stale' | 'building' | 'unavailable'
  /** Build progress, present only while an index is being built. */
  progress?: { parsed: number; total: number; phase: string }
  /** How current the answer is, present once an index answered. */
  freshness?: { dirtyFiles: number; builtAt: number | null; head: string | null }
  /** Repository size, present only on `code_overview`. */
  totals?: { files: number; symbols: number; edges: number; tests: number }
  /** Indexed languages by file count, present only on `code_overview`. */
  languages?: Array<{ lang: string; files: number }>
}

/** Read one property off a value that may be anything at all. */
function field(value: JsonValue, key: string): JsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, JsonValue | undefined>)[key]
}

/** Narrow to a finite number, or undefined. */
function num(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Project the card's view of one tool result.
 *
 * Two shapes arrive here. A result that reached the index carries `freshness`;
 * one that did not carries the manager's `status` and `progress` instead. Both
 * are honest readings of the same question — is this answer current — so they
 * project onto one status field rather than two card states.
 * @param value - the tool's canonical result.
 * @returns The projection, or null when the value carries neither shape.
 */
export function cardMeta(value: JsonValue): JsonValue {
  const freshness = field(value, 'freshness')
  if (freshness !== undefined) {
    const status = field(freshness, 'status')
    const meta: CodeGraphCardMeta = {
      status: status === 'building' || status === 'stale' ? status : 'ready',
      freshness: {
        dirtyFiles: num(field(freshness, 'dirtyFiles')) ?? 0,
        builtAt: num(field(freshness, 'builtAt')) ?? null,
        head: typeof field(freshness, 'head') === 'string' ? field(freshness, 'head') as string : null,
      },
    }
    const totals = field(value, 'totals')
    if (totals !== undefined) {
      meta.totals = {
        files: num(field(totals, 'files')) ?? 0,
        symbols: num(field(totals, 'symbols')) ?? 0,
        edges: num(field(totals, 'edges')) ?? 0,
        tests: num(field(totals, 'tests')) ?? 0,
      }
    }
    const languages = field(value, 'languages')
    if (Array.isArray(languages)) {
      meta.languages = languages.flatMap((entry) => {
        const lang = field(entry, 'lang')
        return typeof lang === 'string' ? [{ lang, files: num(field(entry, 'files')) ?? 0 }] : []
      })
    }
    return meta as unknown as JsonValue
  }

  const status = field(value, 'status')
  if (status !== 'building' && status !== 'unavailable') return null
  const progress = field(value, 'progress')
  const meta: CodeGraphCardMeta = { status }
  if (progress !== undefined && progress !== null) {
    meta.progress = {
      parsed: num(field(progress, 'parsed')) ?? 0,
      total: num(field(progress, 'total')) ?? 0,
      phase: typeof field(progress, 'phase') === 'string' ? field(progress, 'phase') as string : 'scanning',
    }
  }
  return meta as unknown as JsonValue
}
