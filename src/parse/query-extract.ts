/**
 * Query-driven structural extraction.
 *
 * One engine for every language that ships a {@link QueryPack}. Captures follow
 * a fixed convention so a new grammar is data, not a new walker:
 *
 *   @definition.<kind> + @name   declarations
 *   @call / @construction        call sites (name/object/type fields on the node)
 *   @heritage.inherits|implements
 *   @import / @package           optional, decoded by the pack
 *
 * Ownership (which class a method sits in, which method a call sits in) is
 * inferred from source-range containment, which is language-agnostic.
 */
import { Query, type Node } from 'web-tree-sitter'
import type { GraphEdge, GraphNode, ImportRow, NodeKind } from '../db.ts'
import { compactSignature, isTestPath, makeFileNode } from './file-node.ts'
import { type Lang, languageFor, parserFor } from './loader.ts'
import type { QueryPack } from './langs/pack.ts'
import { queryPack } from './langs/registry.ts'
import { distinctQname } from './qname.ts'
import type { ExtractContext, FileExtract, RawCall } from './types.ts'

const PRIMITIVES = new Set([
  'int', 'long', 'short', 'byte', 'char', 'boolean', 'float', 'double', 'void',
])

const TYPE_KINDS = new Set<NodeKind>(['class', 'interface', 'enum', 'type'])
const CALLABLE_KINDS = new Set<NodeKind>(['method', 'function'])

const queryCache = new Map<Lang, Query>()

interface Def {
  kind: NodeKind
  name: string
  node: Node
  start: number
  end: number
  exported: boolean
  receiverParam?: string | undefined
}

/** A {@link Def} once it has been given its qname and parent. */
type Assigned = Def & { qname: string; parent: string }

/**
 * Keyword a declaration node type reads as: `struct_item` -> `struct`.
 *
 * Every pack's type declarations are named `<keyword>_<declaration|item|spec>`
 * in its grammar, so the keyword falls out of the node type without a table
 * per language to keep in sync.
 */
function declarationKeyword(nodeType: string): string | undefined {
  const base = nodeType.replace(/_(declaration|definition|item|spec)$/, '')
  return base === nodeType ? undefined : base.replaceAll('_', ' ')
}

/**
 * Compose a bounded signature for one declaration.
 *
 * A callable is named by its parameter list. Everything else must never fall
 * back to `node.text`: a type's text is its entire body, which inflates
 * `code_find` roughly tenfold per hit and puts every method name into the
 * enclosing type's FTS entry, so searching a method returns its class too.
 */
function signatureFor(def: Def, pack: QueryPack): string {
  const params = def.node.childForFieldName('parameters')?.text
  if (params) {
    // A type that carries parameters is a Java record: keep the keyword, or
    // `Point(int x, int y)` reads as a method.
    const keyword = TYPE_KINDS.has(def.kind) ? declarationKeyword(def.node.type) : undefined
    return compactSignature(keyword ? `${keyword} ${def.name}${params}` : `${def.name}${params}`)
  }
  const shaped = pack.signature?.(def.node, def.kind, def.name)
  if (shaped) return compactSignature(shaped)
  const keyword = declarationKeyword(def.node.type)
  return compactSignature(keyword ? `${keyword} ${def.name}` : def.name)
}

function kindFromCapture(name: string): NodeKind | undefined {
  if (!name.startsWith('definition.')) return undefined
  switch (name.slice('definition.'.length)) {
    case 'class':
    case 'record':
      return 'class'
    case 'interface':
      return 'interface'
    case 'enum':
      return 'enum'
    case 'type':
      return 'type'
    case 'method':
    case 'constructor':
      return 'method'
    case 'function':
      return 'function'
    case 'var':
    case 'field':
      return 'var'
    default:
      return undefined
  }
}

function hasPublicModifier(node: Node): boolean {
  for (const child of node.children) {
    if (child?.type === 'modifiers' && /\bpublic\b/.test(child.text)) return true
  }
  return false
}

function defaultExported(node: Node, kind: NodeKind): boolean {
  if (TYPE_KINDS.has(kind)) return true
  return hasPublicModifier(node)
}

/** Bare type name, stripping generics and package qualifiers. */
function bareTypeName(node: Node): string {
  if (node.type === 'type_identifier' || node.type === 'identifier') return node.text
  let last: string | undefined
  const walk = (n: Node): void => {
    if (n.type === 'type_arguments') return
    if (n.type === 'type_identifier') last = n.text
    for (const child of n.namedChildren) if (child) walk(child)
  }
  walk(node)
  if (last) return last
  const flat = node.text.split('<')[0]?.trim() ?? node.text
  return flat.split('.').pop()?.trim() || flat
}

function typeNames(node: Node): string[] {
  const names: string[] = []
  const walk = (n: Node): void => {
    if (n.type === 'type_arguments') return
    if (n.type === 'type_identifier') {
      names.push(n.text)
      return
    }
    for (const child of n.namedChildren) if (child) walk(child)
  }
  walk(node)
  return names
}

function captureMap(captures: Array<{ name: string; node: Node }>): Map<string, Node> {
  const map = new Map<string, Node>()
  for (const cap of captures) map.set(cap.name, cap.node)
  return map
}

/**
 * Innermost enclosing definition of a source offset, over one group of kinds.
 *
 * Declarations nest and never partially overlap, so the innermost span
 * containing an offset is the last one in start order that contains it — and
 * `defs` is already sorted by start, outer before inner on a tie. Binary search
 * finds where to start; `maxEnd`, the running maximum of `end` over the prefix,
 * ends the walk as soon as no earlier span can still reach the offset. Called
 * once per call site, which is why it is not a scan.
 */
function spanLookup(
  defs: readonly Assigned[],
  kinds: ReadonlySet<NodeKind>,
): (index: number) => string | undefined {
  const spans = defs.filter((d) => kinds.has(d.kind))
  const maxEnd: number[] = []
  let running = 0
  for (const span of spans) {
    running = Math.max(running, span.end)
    maxEnd.push(running)
  }
  return (index: number): string | undefined => {
    let lo = 0
    let hi = spans.length - 1
    let at = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (spans[mid]!.start <= index) {
        at = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    // Every span up to `at` starts at or before `index`; only `end` is left to test.
    for (let i = at; i >= 0 && maxEnd[i]! > index; i--) {
      if (index < spans[i]!.end) return spans[i]!.qname
    }
    return undefined
  }
}

function extractFromMatches(
  path: string,
  lang: Lang,
  source: string,
  root: Node,
  pack: QueryPack,
  query: Query,
  ctx?: ExtractContext | undefined,
): FileExtract {
  const nodes: GraphNode[] = []
  const imports: ImportRow[] = []
  const calls: RawCall[] = []
  const heritage: GraphEdge[] = []
  const locals = new Map<string, string>()
  const fileIsTest = isTestPath(path)
  const fileQname = path

  nodes.push(makeFileNode(path, lang, source, root))

  const matches = query.matches(root)
  const defs: Def[] = []
  const callNodes: Node[] = []
  const constructions: Node[] = []
  const heritageNodes: Array<{ node: Node; kind: GraphEdge['kind'] }> = []

  for (const match of matches) {
    const caps = captureMap(match.captures)
    const importNode = caps.get('import')
    if (importNode && pack.decodeImport) {
      imports.push(...pack.decodeImport(importNode, path))
    }
    const nameNode = caps.get('name')
    for (const [capName, node] of caps) {
      const captured = kindFromCapture(capName)
      if (captured && nameNode) {
        const kind = pack.classifyKind ? pack.classifyKind(node, captured) : captured
        const exported = pack.isExported
          ? pack.isExported(node, kind, nameNode.text)
          : defaultExported(node, kind)
        defs.push({
          kind,
          name: nameNode.text,
          node,
          start: node.startIndex,
          end: node.endIndex,
          exported,
          receiverParam: pack.receiverParam?.(node, kind),
        })
      }
    }
    const call = caps.get('call')
    if (call) callNodes.push(call)
    const ctor = caps.get('construction')
    if (ctor) constructions.push(ctor)
    const inherits = caps.get('heritage.inherits')
    if (inherits) heritageNodes.push({ node: inherits, kind: 'INHERITS' })
    const impl = caps.get('heritage.implements')
    if (impl) heritageNodes.push({ node: impl, kind: 'IMPLEMENTS' })
  }

  defs.sort((a, b) => a.start - b.start || b.end - a.end)
  const assigned: Assigned[] = []
  const byQname = new Map<string, Assigned>()
  const typeByName = new Map<string, string>()
  const stack: Assigned[] = []
  const takenQnames = new Set<string>([fileQname])
  for (const def of defs) {
    while (
      stack.length > 0
      && !(stack[stack.length - 1]!.start < def.start && stack[stack.length - 1]!.end > def.end)
    ) {
      stack.pop()
    }
    const typeName = pack.parentName?.(def.node, def.kind)
    let parent: string
    let qname: string
    if (typeName) {
      const typeFile = ctx?.typeFile?.(path, typeName) ?? path
      parent = `${typeFile}::${typeName}`
      qname = `${parent}.${def.name}`
    } else {
      // The stack carries the qname each entry was given, so the enclosing
      // definition needs no lookup back through `assigned`.
      parent = stack[stack.length - 1]?.qname ?? fileQname
      qname = parent && parent !== fileQname
        ? `${parent}.${def.name}`
        : `${fileQname}::${def.name}`
    }
    // Overloads share a qname (no arity, no parameter types); each one still
    // needs its own node, and the first keeps the bare qname that `this.m()`
    // resolution synthesizes.
    qname = distinctQname(qname, takenQnames)
    const lineStart = def.node.startPosition.row + 1
    const lineEnd = def.node.endPosition.row + 1
    const signature = signatureFor(def, pack)
    nodes.push({
      qname,
      kind: def.kind,
      name: def.name,
      path,
      lang,
      lineStart,
      lineEnd,
      parent,
      signature,
      exported: def.exported ? 1 : 0,
      isTest: fileIsTest ? 1 : 0,
      loc: lineEnd - lineStart + 1,
    })
    if (!locals.has(def.name)) locals.set(def.name, qname)
    const entry: Assigned = { ...def, qname, parent }
    assigned.push(entry)
    byQname.set(qname, entry)
    // First declaration of a type name wins, as the scan this replaces did.
    if (TYPE_KINDS.has(def.kind) && !typeByName.has(def.name)) typeByName.set(def.name, qname)
    stack.push(entry)
  }

  const callableOwnerAt = spanLookup(assigned, CALLABLE_KINDS)
  const typeOwnerAt = spanLookup(assigned, TYPE_KINDS)

  const emitCall = (
    node: Node,
    shape: { name: string; receiver: string | null },
    isConstruction: boolean,
  ): void => {
    const fromQname = callableOwnerAt(node.startIndex) ?? fileQname
    const owner = byQname.get(fromQname)
    let receiver = shape.receiver
    if (receiver && owner?.receiverParam === receiver) receiver = 'this'
    calls.push({
      fromQname,
      name: shape.name,
      receiver,
      isConstruction,
      line: node.startPosition.row + 1,
    })
  }

  for (const call of callNodes) {
    const shape = pack.decodeCall
      ? pack.decodeCall(call)
      : (() => {
        const name = call.childForFieldName('name')?.text
        if (!name) return undefined
        const obj = call.childForFieldName('object')
        return { name, receiver: obj ? obj.text : null }
      })()
    if (!shape) continue
    emitCall(call, shape, false)
  }

  for (const node of constructions) {
    const shape = pack.decodeConstruction
      ? pack.decodeConstruction(node)
      : (() => {
        const typeNode = node.childForFieldName('type')
        if (!typeNode) return undefined
        const name = bareTypeName(typeNode)
        if (!name || PRIMITIVES.has(name)) return undefined
        return { name, receiver: null }
      })()
    if (!shape) continue
    emitCall(node, shape, true)
  }

  for (const h of heritageNodes) {
    const srcName = pack.heritageSrc?.(h.node)
    const src = srcName
      ? (typeByName.get(srcName)
        ?? `${ctx?.typeFile?.(path, srcName) ?? path}::${srcName}`)
      : typeOwnerAt(h.node.startIndex)
    if (!src) continue
    for (const dst of typeNames(h.node)) {
      heritage.push({
        kind: h.kind,
        src,
        dst,
        path,
        line: h.node.startPosition.row + 1,
        resolved: 0,
        confidence: 1,
      })
    }
  }

  return {
    nodes,
    imports,
    calls,
    heritage,
    locals,
    reExports: [],
    starReExports: [],
  }
}

async function compiledQuery(lang: Lang, pack: QueryPack): Promise<Query> {
  const cached = queryCache.get(lang)
  if (cached) return cached
  const language = await languageFor(lang)
  const query = new Query(language, pack.query)
  queryCache.set(lang, query)
  return query
}

/**
 * Parse and extract one file using the language's query pack.
 * @returns The extracted structure, or undefined when the parser produced no tree.
 */
export async function extractWithQuery(
  path: string,
  lang: Lang,
  source: string,
  ctx?: ExtractContext | undefined,
): Promise<FileExtract | undefined> {
  const pack = queryPack(lang)
  if (!pack) return undefined
  const parser = await parserFor(lang)
  const tree = parser.parse(source)
  if (!tree) return undefined
  try {
    const query = await compiledQuery(lang, pack)
    return extractFromMatches(path, lang, source, tree.rootNode, pack, query, ctx)
  } finally {
    tree.delete()
  }
}

/** Release compiled queries (plugin teardown). */
export function disposeQueries(): void {
  for (const q of queryCache.values()) q.delete()
  queryCache.clear()
}
