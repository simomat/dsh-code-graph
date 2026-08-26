/**
 * The indexer's two entry points into import resolution, and the only place
 * the four languages meet.
 *
 * Everything below this module is one language's own business: `ts.ts`,
 * `java.ts`, `go.ts` and `rust.ts` each own an index, a specifier resolver and
 * (bar TS/JS, which needs none) an import expander. The dispatch is here so
 * that adding a language is a module plus a branch, not an edit spread across
 * the indexer.
 */
import type { ImportRow } from '../../db.ts'
import type { ResolverConfig } from './config.ts'
import { expandGoImports, resolveGoSpecifier } from './go.ts'
import { expandJavaImports, resolveJavaSpecifier } from './java.ts'
import { expandRustImports, resolveRustSpecifier } from './rust.ts'
import { resolveRelativeSpecifier, resolveTsSpecifier } from './ts.ts'

/**
 * Resolve one import specifier to a repo-relative file path.
 *
 * Order matters. A relative specifier is answered by the filesystem alone and
 * never falls through — an unresolvable `./x` is external, not a candidate for
 * the alias table. The language lookups come next, since only they can read a
 * bare `com.foo.Bar` or `crate::x` correctly, and the TS/JS table is the
 * fallback for whatever they do not claim.
 *
 * @param spec - the raw specifier text.
 * @param fromPath - repo-relative path of the importing file.
 * @param config - resolver configuration.
 * @returns Repo-relative target path, or undefined for an external/unresolvable module.
 */
export function resolveSpecifier(
  spec: string,
  fromPath: string,
  config: ResolverConfig,
): string | undefined {
  if (spec.startsWith('.')) return resolveRelativeSpecifier(spec, fromPath, config.repoRoot)

  if (fromPath.endsWith('.java') && config.java) {
    const hit = resolveJavaSpecifier(spec, config.java)
    if (hit) return hit
  }
  if (fromPath.endsWith('.go') && config.go) {
    const hit = resolveGoSpecifier(spec, config.go)
    if (hit) return hit
  }
  if (fromPath.endsWith('.rs') && config.rust) {
    const hit = resolveRustSpecifier(spec, fromPath, config.rust)
    if (hit) return hit
  }

  return resolveTsSpecifier(spec, config)
}

/**
 * Per-language import expansion, keyed by file extension.
 *
 * The registration lives here, next to the dispatcher, so adding a language is
 * one row rather than another `if` block in the indexer. Each row pulls its own
 * index off the config: absent index (the language is not present in the repo)
 * means nothing to expand.
 */
const IMPORT_EXPANDERS: ReadonlyArray<{
  ext: string
  expand: (path: string, existing: readonly ImportRow[], config: ResolverConfig)
    => ImportRow[] | undefined
}> = [
  { ext: '.java', expand: (p, rows, c) => c.java && expandJavaImports(p, rows, c.java) },
  { ext: '.go', expand: (p, rows, c) => c.go && expandGoImports(p, rows, c.go) },
  { ext: '.rs', expand: (p, rows, c) => c.rust && expandRustImports(p, rows, c.rust) },
]

/**
 * Expand one file's imports with whatever its language adds.
 *
 * A file has exactly one extension, so at most one expander runs — the first
 * match returns.
 * @param path - repo-relative path of the file being indexed.
 * @param existing - the import rows already extracted for it.
 * @param config - resolver configuration carrying the language indexes.
 * @returns Additional rows to append, empty when the language has no expander.
 */
export function expandImports(
  path: string,
  existing: readonly ImportRow[],
  config: ResolverConfig,
): ImportRow[] {
  for (const entry of IMPORT_EXPANDERS) {
    if (path.endsWith(entry.ext)) return entry.expand(path, existing, config) ?? []
  }
  return []
}
