/**
 * Rust query pack.
 *
 * The awkward shape here is `impl`: methods and the traits a type implements
 * both live in a block that names the type, not under the type's declaration,
 * so `parentName` and `heritageSrc` both walk up to the enclosing `impl_item`.
 * `use` trees nest arbitrarily, so the import decoder is recursive.
 */
import type { Node } from 'web-tree-sitter'
import type { ImportRow, NodeKind } from '../../db.ts'
import { unwrapParens } from './ast.ts'
import type { CallShape, QueryPack } from './pack.ts'

/**
 * Rust std shapes: Option/Result combinators, conversions, iterator adaptors
 * and the string vocabulary. Names a project realistically defines itself —
 * `get`, `insert`, `remove`, `clear`, `len`, `parse`, `map`, `filter`, `find`,
 * `new`, `push`, `send` — are left out even where std also uses them: an
 * unresolved call to one of those is kept as an honest `REFERENCES` edge
 * rather than discarded.
 */
const RUST_NOISE = new Set([
  // Option / Result
  'unwrap', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'unwrap_err',
  'expect', 'expect_err', 'ok', 'ok_or', 'ok_or_else', 'and_then', 'map_err',
  'is_some', 'is_none', 'is_ok', 'is_err',
  // conversion / ownership
  'clone', 'cloned', 'copied', 'to_string', 'to_owned', 'to_vec', 'into',
  'as_str', 'as_ref', 'as_mut', 'as_slice', 'as_bytes', 'borrow', 'borrow_mut',
  // iterator
  'iter', 'iter_mut', 'into_iter', 'collect', 'enumerate', 'zip', 'rev',
  'fold', 'peekable',
  // str / String
  'push_str', 'trim', 'trim_start', 'trim_end', 'to_lowercase', 'to_uppercase',
  'split_whitespace', 'starts_with', 'ends_with',
])

const RUST_QUERY = `
(use_declaration) @import

(function_item
  name: (identifier) @name) @definition.function

(function_signature_item
  name: (identifier) @name) @definition.method

(struct_item
  name: (type_identifier) @name) @definition.class

(enum_item
  name: (type_identifier) @name) @definition.enum

(union_item
  name: (type_identifier) @name) @definition.class

(trait_item
  name: (type_identifier) @name) @definition.interface

(type_item
  name: (type_identifier) @name) @definition.type

(impl_item
  trait: [
    (type_identifier) @heritage.implements
    (generic_type) @heritage.implements
    (scoped_type_identifier) @heritage.implements
  ])

(trait_item
  bounds: (trait_bounds) @heritage.inherits)

(call_expression) @call
(struct_expression) @construction
`

const RUST_BUILTINS = new Set(['Some', 'Ok', 'Err', 'drop', 'panic', 'assert', 'assert_eq', 'assert_ne'])

function rustAncestor(node: Node, type: string): Node | undefined {
  let cur = node.parent
  while (cur) {
    if (cur.type === type) return cur
    cur = cur.parent
  }
  return undefined
}

function rustTypeName(node: Node): string | undefined {
  const cur = unwrapParens(node)
  if (cur.type === 'type_arguments' || cur.type === 'type_parameters') return undefined
  if (cur.type === 'type_identifier' || cur.type === 'identifier') return cur.text
  const named = cur.childForFieldName('name')
  if (named) return rustTypeName(named)
  const inner = cur.childForFieldName('type')
  if (inner) return rustTypeName(inner)
  for (const child of cur.namedChildren) {
    if (!child || child.type === 'type_arguments' || child.type === 'type_parameters') continue
    const hit = rustTypeName(child)
    if (hit) return hit
  }
  return undefined
}

function rustParentType(node: Node): string | undefined {
  const impl = rustAncestor(node, 'impl_item')
  if (impl) {
    const type = impl.childForFieldName('type')
    return type ? rustTypeName(type) : undefined
  }
  const trait = rustAncestor(node, 'trait_item')
  return trait?.childForFieldName('name')?.text
}

function rustHasPub(node: Node): boolean {
  for (const child of node.children) {
    if (child?.type === 'visibility_modifier') return true
  }
  return false
}

function classifyRustKind(node: Node, kind: NodeKind): NodeKind {
  if (kind === 'function' && rustParentType(node)) return 'method'
  return kind
}

function rustExported(node: Node, kind: NodeKind, _name: string): boolean {
  if (rustHasPub(node)) return true
  return kind === 'method' && rustAncestor(node, 'trait_item') !== undefined
}

function rustPathSegments(node: Node): string[] {
  const type = node.type
  if (
    type === 'identifier' || type === 'type_identifier' || type === 'field_identifier'
    || type === 'crate' || type === 'super' || type === 'self'
  ) {
    return [node.text]
  }
  if (type === 'scoped_identifier' || type === 'scoped_type_identifier') {
    const path = node.childForFieldName('path')
    const name = node.childForFieldName('name')
    return [
      ...(path ? rustPathSegments(path) : []),
      ...(name ? rustPathSegments(name) : []),
    ]
  }
  if (type === 'generic_type' || type === 'generic_type_with_turbofish') {
    const inner = node.childForFieldName('type') ?? node.childForFieldName('name')
    return inner ? rustPathSegments(inner) : []
  }
  return node.text.includes('::') ? node.text.split('::').filter(Boolean) : [node.text]
}

function rustUseRows(node: Node, path: string, line: number, prefix: string[]): ImportRow[] {
  const type = node.type
  if (type === 'use_as_clause') {
    const p = node.childForFieldName('path')
    const alias = node.childForFieldName('alias')
    const segs = p ? [...prefix, ...rustPathSegments(p)] : prefix
    const last = segs[segs.length - 1]
    if (!alias || !last) return []
    return [{
      path, spec: segs.join('::'), resolvedPath: null, line,
      kind: 'alias', name: alias.text, imported: last,
    }]
  }
  if (type === 'use_wildcard') {
    const pathNode = node.namedChildren.find((c) => c && c.type !== 'token')
    const segs = pathNode ? [...prefix, ...rustPathSegments(pathNode)] : prefix
    return [{
      path, spec: segs.join('::') || 'self', resolvedPath: null, line,
      kind: 'wildcard', name: '*', imported: '*',
    }]
  }
  if (type === 'use_list') {
    const rows: ImportRow[] = []
    for (const child of node.namedChildren) {
      if (child) rows.push(...rustUseRows(child, path, line, prefix))
    }
    return rows
  }
  if (type === 'scoped_use_list') {
    const p = node.childForFieldName('path')
    const list = node.childForFieldName('list')
    const segs = p ? [...prefix, ...rustPathSegments(p)] : prefix
    return list ? rustUseRows(list, path, line, segs) : []
  }
  const segs = [...prefix, ...rustPathSegments(node)]
  const last = segs[segs.length - 1]
  if (!last) return []
  return [{
    path, spec: segs.join('::'), resolvedPath: null, line,
    kind: 'use', name: last, imported: last,
  }]
}

function decodeRustImport(node: Node, path: string): ImportRow[] {
  const arg = node.childForFieldName('argument')
  if (!arg) return []
  return rustUseRows(arg, path, node.startPosition.row + 1, [])
}

function decodeRustCall(node: Node): CallShape | undefined {
  const fn = node.childForFieldName('function')
  if (!fn) return undefined
  const target = unwrapParens(fn)
  if (target.type === 'identifier') {
    if (RUST_BUILTINS.has(target.text)) return undefined
    return { name: target.text, receiver: null }
  }
  if (target.type === 'field_expression') {
    const field = target.childForFieldName('field')
    const value = target.childForFieldName('value')
    if (!field || field.type === 'integer_literal') return undefined
    const receiver = value ? unwrapParens(value).text : null
    return { name: field.text, receiver: receiver === 'self' ? 'this' : receiver }
  }
  if (target.type === 'scoped_identifier') {
    const name = target.childForFieldName('name')
    const pathNode = target.childForFieldName('path')
    if (!name) return undefined
    return { name: name.text, receiver: pathNode ? pathNode.text : null }
  }
  return undefined
}

function decodeRustConstruction(node: Node): CallShape | undefined {
  const name = node.childForFieldName('name')
  if (!name) return undefined
  const segs = rustPathSegments(name)
  const last = segs[segs.length - 1]
  if (!last) return undefined
  return { name: last, receiver: segs.length > 1 ? segs.slice(0, -1).join('::') : null }
}

function rustHeritageSrc(node: Node): string | undefined {
  const impl = rustAncestor(node, 'impl_item')
  const type = impl?.childForFieldName('type')
  return type ? rustTypeName(type) : undefined
}

export const RUST_PACK: QueryPack = {
  query: RUST_QUERY,
  decodeImport: decodeRustImport,
  decodeCall: decodeRustCall,
  decodeConstruction: decodeRustConstruction,
  isExported: rustExported,
  classifyKind: classifyRustKind,
  parentName: (node, kind) => (kind === 'method' ? rustParentType(node) : undefined),
  heritageSrc: rustHeritageSrc,
  noiseMethods: RUST_NOISE,
}
