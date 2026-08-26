/**
 * The schemastery schema resolving the `code-graph` section.
 *
 * Split from the contract in `config.ts` so the browser half can read the
 * namespace and the family list without pulling a schema builder into its
 * bundle. Only the host half imports this module.
 */
import z from '@deepseek-ai/schemastery'
import {
  type CodeGraphConfig,
  DEFAULT_BUDGET,
  DEFAULT_MAX_BUDGET,
  DEFAULT_MAX_FILE_BYTES,
  LANG_FAMILIES,
  MIN_BUDGET,
} from './config.ts'

/**
 * Schema of the `code-graph` settings section.
 *
 * Every default lives here rather than at the use site: a configuration surface
 * renders the resolved section, so a default the schema does not carry reads
 * there as no value at all.
 */
export const CodeGraphConfigSchema: z<CodeGraphConfig> = z.object({
  defaultBudget: z.number().step(1).min(MIN_BUDGET).default(DEFAULT_BUDGET)
    .description('Token budget for a tool result that does not request one.'),
  maxBudget: z.number().step(1).min(MIN_BUDGET).default(DEFAULT_MAX_BUDGET)
    .description('Largest budget a tool call may ask for.'),
  exclude: z.array(z.string()).default([])
    .description('Extra directory names or path prefixes to keep out of the index, '
      + 'on top of the built-in list (node_modules, dist, target, ...).'),
  maxFileBytes: z.number().step(1).min(1024).default(DEFAULT_MAX_FILE_BYTES)
    .description('Files larger than this are skipped as generated rather than authored.'),
  languages: z.array(z.union([...LANG_FAMILIES])).default([...LANG_FAMILIES])
    .description('Language families to parse. Dropping one skips its files and its grammar.'),
  indexDir: z.string()
    .description('Directory holding the index databases. Defaults to $DSH_HOME (or ~/.dsh).'),
})
