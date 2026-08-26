/**
 * Token budgeting for tool results.
 *
 * The whole point of this plugin is spending fewer tokens than a read/grep loop,
 * so every result is bounded. Truncation drops whole lowest-ranked rows — never
 * cutting a string mid-structure — so the model always receives well-formed
 * records plus an honest `truncated` flag.
 */

import { DEFAULT_BUDGET, DEFAULT_MAX_BUDGET, MIN_BUDGET } from '../config.ts'

/** The two budget bounds a call is clamped into. */
export interface BudgetLimits {
  /** Budget for a call that requests none. */
  defaultBudget: number
  /** Largest budget a call may request. */
  maxBudget: number
}

/** Bounds used when no configuration has been resolved (tests, bare calls). */
export const DEFAULT_LIMITS: BudgetLimits = {
  defaultBudget: DEFAULT_BUDGET,
  maxBudget: DEFAULT_MAX_BUDGET,
}

/**
 * Estimate the token cost of a JSON-serializable value.
 *
 * Deliberately a cheap heuristic (~4 characters per token) rather than a real
 * tokenizer: the plugin must not take a model dependency, and the estimate only
 * needs to be good enough to keep results small.
 * @param value - any JSON-serializable value.
 * @returns Estimated token count.
 */
export function estimateTokens(value: unknown): number {
  if (value === undefined) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return Math.ceil(text.length / 4)
}

/**
 * Clamp a caller-supplied budget into the configured range.
 * @param requested - the requested budget, possibly undefined or out of range.
 * @param limits - resolved bounds; the built-in defaults when omitted.
 * @returns A usable positive budget.
 */
export function clampBudget(requested: number | undefined, limits: BudgetLimits = DEFAULT_LIMITS): number {
  if (requested === undefined || !Number.isFinite(requested)) return limits.defaultBudget
  return Math.max(MIN_BUDGET, Math.min(limits.maxBudget, Math.floor(requested)))
}

export interface BudgetedRows<T> {
  rows: T[]
  truncated: boolean
  used: number
  /** How many rows were dropped to fit. */
  dropped: number
}

/**
 * Take as many rows as fit within a token budget.
 *
 * Rows must already be ordered most-valuable-first: truncation keeps the head.
 * @param rows - candidate rows in priority order.
 * @param budget - token budget for the row payload.
 * @param overhead - tokens already committed by the enclosing envelope.
 * @returns The retained rows plus truncation bookkeeping.
 */
export function fitRows<T>(rows: T[], budget: number, overhead = 0): BudgetedRows<T> {
  const kept: T[] = []
  let used = overhead
  for (const row of rows) {
    const cost = estimateTokens(row)
    if (used + cost > budget && kept.length > 0) break
    kept.push(row)
    used += cost
  }
  return {
    rows: kept,
    truncated: kept.length < rows.length,
    used,
    dropped: rows.length - kept.length,
  }
}
