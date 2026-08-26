/**
 * Go query pack.
 *
 * Three shapes the Java defaults get wrong: methods hang off a receiver rather
 * than nesting inside their type, export is a capital letter rather than a
 * modifier, and `type X struct` has no `parameters` field to build a signature
 * from.
 */
import type { Node } from 'web-tree-sitter'
import type { ImportRow, NodeKind } from '../../db.ts'
import { unwrapParens } from './ast.ts'
import type { CallShape, QueryPack } from './pack.ts'

/**
 * Go stdlib shapes only — fmt, testing, sync, errors and the two byte sinks.
 * Deliberately short: idiomatic Go method names are ordinary English verbs, so
 * anything broader (`Get`, `Add`, `Len`, `Read`, `Write`, `Run`) would drop
 * project methods far more often than library calls.
 */
const GO_NOISE = new Set([
  // fmt
  'Printf', 'Println', 'Print', 'Sprintf', 'Sprint', 'Sprintln',
  'Fprintf', 'Fprintln', 'Fprint',
  // testing (t.*)
  'Errorf', 'Fatal', 'Fatalf', 'Fatalln', 'Log', 'Logf', 'Helper',
  'Skip', 'Skipf', 'SkipNow', 'Cleanup', 'Parallel', 'Fail', 'FailNow',
  // sync
  'Lock', 'Unlock', 'RLock', 'RUnlock',
  // errors
  'Error', 'Unwrap',
  // strings.Builder / bytes.Buffer
  'WriteString', 'WriteByte',
])

const GO_QUERY = `
(package_clause) @package
(import_spec) @import

(function_declaration
  name: (identifier) @name) @definition.function

(method_declaration
  name: (field_identifier) @name) @definition.method

(type_spec
  name: (type_identifier) @name) @definition.type

(type_alias
  name: (type_identifier) @name) @definition.type

(call_expression) @call
(composite_literal) @construction
`

const GO_BUILTINS = new Set([
  'new', 'make', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'min', 'max', 'clear',
])

function goExported(name: string): boolean {
  const first = name[0]
  return first !== undefined && first !== first.toLowerCase()
}

function firstTypeIdentifier(node: Node): string | undefined {
  if (node.type === 'type_identifier' || node.type === 'identifier') return node.text
  for (const child of node.namedChildren) {
    if (!child) continue
    const hit = firstTypeIdentifier(child)
    if (hit) return hit
  }
  return undefined
}

function goReceiverType(node: Node): string | undefined {
  const recv = node.childForFieldName('receiver')
  if (!recv) return undefined
  for (const param of recv.namedChildren) {
    if (!param) continue
    const type = param.childForFieldName('type')
    if (type) return firstTypeIdentifier(type)
  }
  return undefined
}

function goReceiverParam(node: Node): string | undefined {
  const recv = node.childForFieldName('receiver')
  if (!recv) return undefined
  for (const param of recv.namedChildren) {
    if (!param) continue
    const name = param.childForFieldName('name')
    if (name) return name.text
    for (const child of param.namedChildren) {
      if (child?.type === 'identifier') return child.text
    }
  }
  return undefined
}

function splitGoType(node: Node): CallShape | undefined {
  const type = unwrapParens(node)
  if (type.type === 'type_identifier' || type.type === 'identifier') {
    return { name: type.text, receiver: null }
  }
  if (type.type === 'qualified_type') {
    const name = type.childForFieldName('name')
    const pkg = type.childForFieldName('package')
    if (!name) return undefined
    return { name: name.text, receiver: pkg?.text ?? null }
  }
  if (type.type === 'generic_type' || type.type === 'pointer_type') {
    const inner = type.childForFieldName('type') ?? type.namedChildren.find((c) => c !== null)
    if (inner) return splitGoType(inner)
  }
  return undefined
}

function decodeGoCall(node: Node): CallShape | undefined {
  const fn = node.childForFieldName('function')
  if (!fn) return undefined
  const target = unwrapParens(fn)
  if (target.type === 'identifier') {
    if (GO_BUILTINS.has(target.text)) return undefined
    return { name: target.text, receiver: null }
  }
  if (target.type === 'selector_expression') {
    const field = target.childForFieldName('field')
    const operand = target.childForFieldName('operand')
    if (!field) return undefined
    return { name: field.text, receiver: operand ? unwrapParens(operand).text : null }
  }
  return undefined
}

function decodeGoConstruction(node: Node): CallShape | undefined {
  const type = node.childForFieldName('type')
  if (!type) return undefined
  return splitGoType(type)
}

function unquoteGo(raw: string): string {
  if ((raw.startsWith('`') && raw.endsWith('`')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

function decodeGoImport(node: Node, path: string): ImportRow[] {
  const specNode = node.childForFieldName('path')
  if (!specNode) return []
  const spec = unquoteGo(specNode.text)
  if (!spec) return []
  const line = node.startPosition.row + 1
  const alias = node.childForFieldName('name')
  if (!alias) {
    return [{ path, spec, resolvedPath: null, line, kind: 'namespace', name: null }]
  }
  if (alias.type === 'dot' || alias.text === '.') {
    return [{ path, spec, resolvedPath: null, line, kind: 'dot', name: '*', imported: '*' }]
  }
  if (alias.type === 'blank_identifier' || alias.text === '_') {
    return [{ path, spec, resolvedPath: null, line, kind: 'side-effect', name: '_' }]
  }
  return [{ path, spec, resolvedPath: null, line, kind: 'alias', name: alias.text, imported: '*' }]
}

/**
 * `type X struct` / `type X interface` / `type X map[string]int`.
 *
 * A composite type is named by its keyword alone — its text is the whole body,
 * which is exactly what must not reach a signature. Everything else is short
 * enough to show verbatim, and is dropped rather than truncated if it is not.
 */
function goTypeSignature(node: Node, _kind: NodeKind, name: string): string | undefined {
  if (node.type !== 'type_spec' && node.type !== 'type_alias') return undefined
  const alias = node.type === 'type_alias' ? '= ' : ''
  const type = node.childForFieldName('type')
  if (!type) return `type ${name}`
  const shape = type.type === 'struct_type' ? 'struct'
    : type.type === 'interface_type' ? 'interface'
    : type.type === 'func_type' ? 'func'
    : type.text.length <= 60 ? type.text
    : ''
  return shape ? `type ${name} ${alias}${shape}` : `type ${name}`
}

function classifyGoKind(node: Node, kind: NodeKind): NodeKind {
  if (kind !== 'type') return kind
  const type = node.childForFieldName('type')
  if (type?.type === 'struct_type') return 'class'
  if (type?.type === 'interface_type') return 'interface'
  return 'type'
}

export const GO_PACK: QueryPack = {
  query: GO_QUERY,
  decodeImport: decodeGoImport,
  decodeCall: decodeGoCall,
  decodeConstruction: decodeGoConstruction,
  isExported: (_node, _kind, name) => goExported(name),
  classifyKind: classifyGoKind,
  parentName: (node, kind) => (kind === 'method' ? goReceiverType(node) : undefined),
  receiverParam: (node, kind) => (kind === 'method' ? goReceiverParam(node) : undefined),
  signature: goTypeSignature,
  noiseMethods: GO_NOISE,
}
