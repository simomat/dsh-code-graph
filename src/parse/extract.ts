/**
 * Dispatch structural extraction by language.
 *
 * The TypeScript/JavaScript family keeps its dedicated walker (import graph
 * precision). Every other language goes through the query engine.
 */
import { type Lang } from './loader.ts'
import { queryPack } from './langs/registry.ts'
import { extractWithQuery } from './query-extract.ts'
import { extractFile as extractTsFamily } from './ts-extract.ts'
import type { ExtractContext, FileExtract } from './types.ts'

export type { ExtractContext, FileExtract, RawCall } from './types.ts'

/**
 * Parse and extract one file with the extractor that language requires.
 * @returns The extracted structure, or undefined when the parser produced no tree.
 */
export async function extractFile(
  path: string,
  lang: Lang,
  source: string,
  ctx?: ExtractContext | undefined,
): Promise<FileExtract | undefined> {
  if (queryPack(lang)) return extractWithQuery(path, lang, source, ctx)
  return extractTsFamily(path, lang, source)
}
