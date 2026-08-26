/**
 * Tree-sitter node helpers shared by more than one language module.
 *
 * Sibling of `pack.ts` for the same reason: `go.ts` and `rust.ts` both need
 * this and neither owns it.
 */
import type { Node } from 'web-tree-sitter'

/**
 * Step through `(expr)` / `(type)` wrappers to the thing being wrapped.
 *
 * Both grammars name these nodes the same way, and both put the payload in the
 * first named child rather than a field.
 */
export function unwrapParens(node: Node): Node {
  let cur = node
  while (cur.type === 'parenthesized_expression' || cur.type === 'parenthesized_type') {
    const inner = cur.namedChildren.find((c) => c !== null)
    if (!inner) break
    cur = inner
  }
  return cur
}
