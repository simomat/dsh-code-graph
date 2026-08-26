/**
 * Facts every extractor needs about a file, independent of how it walks the AST.
 *
 * The TS/JS walker and the query engine both open by deciding whether the path
 * looks like tests and pushing the `kind: 'file'` node, and both bound their
 * signatures the same way. Those three had drifted into two copies — notably
 * two different test-path regexes that agreed only because neither extractor
 * ever saw the other's file types. One superset regex lives here so a new
 * language adds its clause once.
 */
import type { GraphNode } from '../db.ts'
import type { Lang } from './loader.ts'

/**
 * Conventional test-path shapes across every supported language.
 *
 * In order: a `test`/`tests`/`spec`/`__tests__` path segment (all languages),
 * JUnit's `FooTest`/`FooTests`/`FooIT` (Java), `foo_test.go` / `foo_test.rs`,
 * and `foo.test.ts` / `foo.spec.js` (TS/JS).
 */
const TEST_FILE_RE =
  /(^|[./\\])(test|tests|spec|__tests__)[./\\]|[A-Za-z_]\w*(Test|Tests|IT)\.java$|_test\.(go|rs)$|\.(test|spec)\.[cm]?[jt]sx?$/

/** Whether a repo-relative path is conventionally a test file. */
export function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path)
}

/** Compact a signature to a single bounded line for prompt safety. */
export function compactSignature(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The `kind: 'file'` node every extract starts with.
 *
 * @param path - repo-relative file path, which is also the file's qname.
 * @param lang - detected language.
 * @param source - full file text, used for `loc`.
 * @param root - tree-sitter root node, used for `lineEnd`.
 * @returns The file node. `isTest` reflects the path only; the TS walker may
 * still promote it once it has seen the file's calls.
 */
export function makeFileNode(
  path: string,
  lang: Lang,
  source: string,
  root: { endPosition: { row: number } },
): GraphNode {
  return {
    qname: path,
    kind: 'file',
    name: path.split('/').pop() ?? path,
    path,
    lang,
    lineStart: 1,
    lineEnd: root.endPosition.row + 1,
    parent: null,
    signature: null,
    exported: 1,
    isTest: isTestPath(path) ? 1 : 0,
    loc: source.length === 0 ? 0 : source.split('\n').length,
  }
}
