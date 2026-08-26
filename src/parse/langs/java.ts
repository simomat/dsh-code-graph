/**
 * Java query pack.
 *
 * The engine's defaults are Java-shaped, so this is the smallest of the three:
 * a query, an import decoder, and the noise table. Nothing overrides call,
 * construction, export or kind handling.
 */
import type { Node } from 'web-tree-sitter'
import type { ImportRow } from '../../db.ts'
import type { QueryPack } from './pack.ts'

/**
 * JVM stdlib shapes: Object, String/StringBuilder, Collections, Streams,
 * Optional and the common assertion vocabularies. All are called on a
 * receiver, and a project method sharing one of these names still reaches the
 * graph whenever it resolves — only the unresolvable ones are dropped.
 */
const JAVA_NOISE = new Set([
  // java.lang.Object and boxing
  'toString', 'equals', 'hashCode', 'getClass', 'clone', 'compareTo',
  'wait', 'notify', 'notifyAll', 'valueOf', 'intValue', 'longValue', 'doubleValue',
  // printing / formatting
  'println', 'printf', 'print', 'format', 'append',
  // String
  'length', 'charAt', 'substring', 'trim', 'strip', 'split', 'join', 'concat',
  'replace', 'matches', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase',
  // Collections / Map
  'size', 'isEmpty', 'get', 'set', 'add', 'addAll', 'remove', 'removeAll',
  'put', 'putAll', 'containsKey', 'containsValue', 'contains', 'keySet',
  'entrySet', 'values', 'iterator', 'hasNext', 'next', 'getKey', 'getValue',
  // Stream / Optional
  'stream', 'forEach', 'collect', 'map', 'filter', 'anyMatch', 'allMatch',
  'findFirst', 'sorted', 'toList', 'of', 'ofNullable', 'orElse', 'orElseGet',
  'orElseThrow', 'isPresent', 'ifPresent',
  // resources / throwables
  'close', 'flush', 'getMessage', 'printStackTrace',
  // assertions
  'assertEquals', 'assertTrue', 'assertFalse', 'assertNull', 'assertNotNull',
  'assertThat', 'isEqualTo', 'hasSize',
])

const JAVA_QUERY = `
(package_declaration) @package
(import_declaration) @import

(class_declaration
  name: (identifier) @name) @definition.class

(interface_declaration
  name: (identifier) @name) @definition.interface

(enum_declaration
  name: (identifier) @name) @definition.enum

(record_declaration
  name: (identifier) @name) @definition.record

(annotation_type_declaration
  name: (identifier) @name) @definition.interface

(method_declaration
  name: (identifier) @name) @definition.method

(constructor_declaration
  name: (identifier) @name) @definition.constructor

(compact_constructor_declaration
  name: (identifier) @name) @definition.constructor

(method_invocation) @call
(object_creation_expression) @construction

(superclass) @heritage.inherits
(super_interfaces) @heritage.implements
(extends_interfaces) @heritage.inherits
`

function javaSpec(node: Node): { spec: string; isStatic: boolean; isStar: boolean } | undefined {
  let isStatic = false
  let isStar = false
  let spec: string | undefined
  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'static' || child.text === 'static') isStatic = true
    else if (child.type === 'asterisk') isStar = true
    else if (child.type === 'identifier' || child.type === 'scoped_identifier') spec = child.text
  }
  return spec ? { spec, isStatic, isStar } : undefined
}

function decodeJavaImport(node: Node, path: string): ImportRow[] {
  const parsed = javaSpec(node)
  if (!parsed) return []
  const { spec, isStatic, isStar } = parsed
  const line = node.startPosition.row + 1
  const simple = spec.split('.').pop()
  if (!simple) return []
  if (isStar && isStatic) {
    return [{ path, spec: `${spec}.*`, resolvedPath: null, line, kind: 'static-star', name: '*', imported: '*' }]
  }
  if (isStar) {
    return [{ path, spec: `${spec}.*`, resolvedPath: null, line, kind: 'wildcard', name: '*', imported: '*' }]
  }
  if (isStatic) {
    return [{ path, spec, resolvedPath: null, line, kind: 'static', name: simple, imported: simple }]
  }
  return [{ path, spec, resolvedPath: null, line, kind: 'named', name: simple, imported: simple }]
}

export const JAVA_PACK: QueryPack = {
  query: JAVA_QUERY,
  decodeImport: decodeJavaImport,
  noiseMethods: JAVA_NOISE,
}
