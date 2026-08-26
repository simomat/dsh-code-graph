/**
 * The configuration contract: namespace, shape, defaults, and the invariants a
 * section must satisfy.
 *
 * Deliberately dependency-free. Both halves of this package read it, and the
 * browser half is bundled: a schema builder imported here would be inlined into
 * the page for the sake of two string constants. The schemastery schema that
 * resolves this shape lives next door in `settings.ts`, which only the host half
 * imports.
 *
 * The section is flat on purpose. A settings surface addresses one top-level
 * field per write, so a nested `budget: { default, max }` could not be edited or
 * reset field by field. Arrays replace wholesale in the settings merge, which is
 * exactly what `exclude` and `languages` want.
 */

/** Settings namespace owned by this plugin; also the card's slot key. */
export const CODE_GRAPH_NS = 'code-graph'

/**
 * The wire names of this plugin's tools.
 *
 * Shared with the browser half, where each name is the key a conversation card
 * registers under. A name that matched nothing would silently fall back to the
 * generic card, so both halves read one list rather than two spellings.
 */
export const TOOL_NAMES = ['code_overview', 'code_find', 'code_relations', 'code_impact'] as const

/** One tool's wire name. */
export type ToolName = typeof TOOL_NAMES[number]

/** Language families a user can turn on or off, coarser than the parser's `Lang`. */
export const LANG_FAMILIES = ['typescript', 'java', 'go', 'rust'] as const

/** One selectable language family. */
export type LangFamily = typeof LANG_FAMILIES[number]

/** Default token budget for one tool result. */
export const DEFAULT_BUDGET = 1500

/** Default ceiling a caller may request. */
export const DEFAULT_MAX_BUDGET = 6000

/** Default size above which a file is treated as generated rather than authored. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/** Smallest budget a result can be squeezed into and still say anything. */
export const MIN_BUDGET = 100

/** The user-editable section of this plugin's configuration. */
export interface CodeGraphConfig {
  /** Token budget for a tool result that does not ask for one. */
  defaultBudget: number
  /** Hard ceiling on the budget a tool call may request. */
  maxBudget: number
  /** Extra path prefixes and directory names to keep out of the index. */
  exclude: string[]
  /** Files larger than this are skipped as generated rather than authored. */
  maxFileBytes: number
  /** Language families to parse; a family left out is never indexed. */
  languages: LangFamily[]
  /** Directory holding the index databases; defaults to the harness home. */
  indexDir?: string
}

/**
 * Reject a resolved section this plugin could not act on.
 *
 * The schema cannot express the relation between the two budgets, and a stored
 * `defaultBudget` above `maxBudget` would silently clamp every result to a value
 * the user never chose. Throwing here refuses the write that produced it.
 * @param config - the resolved section, schema-valid by construction.
 */
export function assertServiceableConfig(config: CodeGraphConfig): void {
  if (config.defaultBudget > config.maxBudget) {
    throw new Error(
      `code-graph: defaultBudget (${config.defaultBudget}) must not exceed maxBudget (${config.maxBudget})`,
    )
  }
  if (config.languages.length === 0) {
    throw new Error('code-graph: languages must name at least one family, or nothing can be indexed')
  }
}

/**
 * Whether two sections differ in a way that invalidates a built index.
 *
 * The budgets are read per call, so a change to them needs no rebuild; every
 * other field decides what goes into the database.
 * @param next - the newly resolved section.
 * @param prev - the section in force until now.
 * @returns true when open databases must be dropped and rebuilt.
 */
export function invalidatesIndex(next: CodeGraphConfig, prev: CodeGraphConfig): boolean {
  return next.maxFileBytes !== prev.maxFileBytes
    || next.indexDir !== prev.indexDir
    || next.exclude.join('\0') !== prev.exclude.join('\0')
    || [...next.languages].sort().join('\0') !== [...prev.languages].sort().join('\0')
}
