/**
 * Structural extraction for the TypeScript/JavaScript family.
 *
 * Walks the tree-sitter AST once and emits nodes (declarations), raw call
 * sites, imports, and inheritance. Call targets are left UNRESOLVED here — the
 * extractor records the syntactic receiver shape and the resolver later turns
 * it into a qualified name. Keeping those phases apart is what lets resolution
 * use the import graph instead of guessing by bare name.
 */
import type { Node as TsNode } from 'web-tree-sitter'
import type { GraphEdge, GraphNode, ImportRow, NodeKind } from '../db.ts'
import { compactSignature, isTestPath, makeFileNode } from './file-node.ts'
import { type Lang, parserFor } from './loader.ts'
import { distinctQname } from './qname.ts'
import type { FileExtract, RawCall } from './types.ts'

export type { FileExtract, RawCall } from './types.ts'

const TEST_FN_RE = /^(describe|it|test|suite|bench)$/
/** Modules whose import is itself evidence that the file drives a test runner. */
const TEST_MODULE_RE =
  /^(node:test|vitest(\/.*)?|jest|@jest\/globals|mocha|bun:test|uvu(\/.*)?|ava|tap|tape|@playwright\/test)$/

/**
 * Decide whether a file outside the conventional test paths drives a test runner.
 *
 * One receiverless call to `test` / `it` / `describe` is not evidence: marking
 * the file hides every symbol in it from `hubs` and from `TESTED_BY`, and a
 * production file with a local helper called `test()` would pay that in full.
 * So the name has to come from somewhere other than this file, and it needs
 * corroboration — an import from a known test module, or a second distinct
 * framework name, which is the only signal available when the runner injects
 * its globals (jest, mocha) and nothing is imported at all.
 *
 * @param nodes - the file's declarations, used to spot a local helper.
 * @param imports - the file's import rows.
 * @param calls - the file's raw call sites.
 * @returns True when the file should be marked as tests.
 */
function usesTestFramework(nodes: GraphNode[], imports: ImportRow[], calls: RawCall[]): boolean {
  const declared = new Set<string>()
  for (const n of nodes) if (n.kind !== 'file') declared.add(n.name)

  const framework = new Set<string>()
  for (const c of calls) {
    if (c.receiver === null && TEST_FN_RE.test(c.name) && !declared.has(c.name)) framework.add(c.name)
  }
  if (framework.size === 0) return false
  if (framework.size >= 2) return true
  return imports.some((i) => TEST_MODULE_RE.test(i.spec))
}

/** Collect direct named children of a given type. */
function childrenOfType(node: TsNode, type: string): TsNode[] {
  const out: TsNode[] = []
  for (const c of node.namedChildren) if (c?.type === type) out.push(c)
  return out
}

/**
 * Extract structure from one already-parsed file.
 * @param path - repo-relative file path.
 * @param lang - detected language.
 * @param source - full file text.
 * @param root - tree-sitter root node.
 * @returns The file's nodes, imports, raw calls, and heritage edges.
 */
function extractFromTree(path: string, lang: Lang, source: string, root: TsNode): FileExtract {
  const nodes: GraphNode[] = []
  const imports: ImportRow[] = []
  const calls: RawCall[] = []
  const heritage: GraphEdge[] = []
  const locals = new Map<string, string>()
  const reExports: Array<{ name: string; orig: string; spec: string }> = []
  const starReExports: string[] = []
  const fileIsTest = isTestPath(path)
  const fileQname = path
  const takenQnames = new Set<string>([fileQname])

  nodes.push(makeFileNode(path, lang, source, root))

  const addNode = (
    kind: NodeKind,
    name: string,
    node: TsNode,
    opts: {
      parent?: string | null
      signature?: string | null
      exported?: boolean
      /** Declared inside a callable — not a name the file exposes to `locals`. */
      nested?: boolean
    } = {},
  ): string => {
    const parent = opts.parent ?? null
    // Declaration merging (`interface Foo` twice, a re-declared `var`) repeats a
    // qname; discriminate so the later declaration adds a node instead of
    // overwriting the earlier one.
    const qname = distinctQname(
      parent && parent !== fileQname ? `${parent}.${name}` : `${fileQname}::${name}`,
      takenQnames,
    )
    const lineStart = node.startPosition.row + 1
    const lineEnd = node.endPosition.row + 1
    nodes.push({
      qname,
      kind,
      name,
      path,
      lang,
      lineStart,
      lineEnd,
      parent,
      signature: opts.signature ?? null,
      exported: opts.exported ? 1 : 0,
      isTest: fileIsTest ? 1 : 0,
      loc: lineEnd - lineStart + 1,
    })
    if (!opts.nested && !locals.has(name)) locals.set(name, qname)
    return qname
  }

  /** Record a call site, decomposing `a.b.c()` into receiver + bare name. */
  const addCall = (fromQname: string, callNode: TsNode): void => {
    const fn = callNode.childForFieldName('function')
    if (!fn) return
    const line = callNode.startPosition.row + 1
    if (fn.type === 'identifier') {
      calls.push({ fromQname, name: fn.text, receiver: null, isConstruction: false, line })
      return
    }
    if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property')
      const obj = fn.childForFieldName('object')
      if (prop) {
        calls.push({
          fromQname,
          name: prop.text,
          receiver: obj ? obj.text : null,
          isConstruction: false,
          line,
        })
      }
    }
  }

  const addNew = (fromQname: string, newNode: TsNode): void => {
    const ctor = newNode.childForFieldName('constructor')
    if (!ctor) return
    const name = ctor.type === 'member_expression'
      ? (ctor.childForFieldName('property')?.text ?? ctor.text)
      : ctor.text
    calls.push({
      fromQname,
      name,
      receiver: null,
      isConstruction: true,
      line: newNode.startPosition.row + 1,
    })
  }

  /**
   * Visit one node, attributing what it contains to `owner`.
   *
   * A declaration met on the way down is emitted as its own node and takes
   * ownership of its body, so a helper declared inside a function is findable
   * and its calls are attributed to it rather than to the enclosing owner.
   * Nothing is lost upward: the CONTAINS edge runs owner -> nested, and impact
   * traversal walks CONTAINS in reverse, so the enclosing declaration is still
   * reached through it.
   */
  const visit = (node: TsNode, owner: string): void => {
    if (node.type === 'call_expression') {
      addCall(owner, node)
      // Arguments may contain further calls (callbacks, nested calls).
      const args = node.childForFieldName('arguments')
      if (args) walkBody(args, owner)
      const fn = node.childForFieldName('function')
      if (fn && fn.type === 'member_expression') {
        const obj = fn.childForFieldName('object')
        if (obj && obj.type === 'call_expression') walkBody(obj, owner)
      }
      return
    }
    if (node.type === 'new_expression') {
      addNew(owner, node)
      const args = node.childForFieldName('arguments')
      if (args) walkBody(args, owner)
      return
    }
    if (handleNested(node, owner)) return
    walkBody(node, owner)
  }

  /** Walk a subtree's children, attributing what they contain to `owner`. */
  const walkBody = (node: TsNode, owner: string): void => {
    for (const child of node.namedChildren) {
      if (!child) continue
      visit(child, owner)
    }
  }

  /**
   * Emit a `const f = () => …` / `const f = function () {}` declaration.
   * Shared by the top-level and the nested path so both compose the same
   * signature and hand the body to the new node.
   */
  const declareFunction = (
    declarator: TsNode,
    name: string,
    value: TsNode,
    exported: boolean,
    owner: string,
  ): void => {
    const params = value.childForFieldName('parameters')?.text ?? '()'
    const q = addNode('function', name, declarator, {
      parent: owner,
      signature: compactSignature(`${name} = ${params} =>`),
      exported,
      nested: owner !== fileQname,
    })
    const body = value.childForFieldName('body')
    // `visit`, not `walkBody`: a concise arrow body (`() => f()`) *is* the call.
    if (body) visit(body, q)
  }

  /**
   * Handle a declaration met inside another node's body.
   *
   * Only callables and classes become nodes. A local `const n = 1` is data, and
   * a node per local would inflate the graph for nothing — such a declarator is
   * walked as before, with its initializer's calls attributed to `owner`.
   *
   * @returns Whether the node was consumed; the caller must not descend again.
   */
  const handleNested = (node: TsNode, owner: string): boolean => {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'abstract_class_declaration':
        return handleDeclaration(node, false, owner)
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of childrenOfType(node, 'variable_declarator')) {
          const name = d.childForFieldName('name')?.text
          const value = d.childForFieldName('value')
          if (
            name && value
            && (value.type === 'arrow_function' || value.type === 'function_expression')
          ) {
            declareFunction(d, name, value, false, owner)
          } else {
            walkBody(d, owner)
          }
        }
        return true
      }
      default:
        return false
    }
  }

  /** Handle a class and its members, owned by `owner` (the file, or a callable). */
  const handleClass = (node: TsNode, exported: boolean, owner: string): void => {
    const nested = owner !== fileQname
    const nameNode = node.childForFieldName('name')
    const className = nameNode?.text ?? '(anonymous)'
    const classQname = addNode('class', className, node, {
      parent: owner,
      signature: compactSignature(`class ${className}`),
      exported,
      nested,
    })

    for (const h of childrenOfType(node, 'class_heritage')) {
      for (const clause of h.namedChildren) {
        if (!clause) continue
        const kind = clause.type === 'implements_clause' ? 'IMPLEMENTS' : 'INHERITS'
        for (const t of clause.namedChildren) {
          if (!t) continue
          // Strip generic arguments: `Base<T>` inherits from `Base`.
          const base = t.type === 'generic_type'
            ? (t.childForFieldName('name')?.text ?? t.text)
            : t.text
          const bare = base.split('<')[0]?.trim()
          if (!bare) continue
          heritage.push({
            kind,
            src: classQname,
            dst: bare,
            path,
            line: clause.startPosition.row + 1,
            resolved: 0,
            confidence: 1,
          })
        }
      }
    }

    const body = node.childForFieldName('body')
    if (!body) return
    for (const member of body.namedChildren) {
      if (!member) continue
      if (member.type === 'method_definition') {
        const mName = member.childForFieldName('name')?.text ?? '(anonymous)'
        const params = member.childForFieldName('parameters')?.text ?? '()'
        const ret = member.childForFieldName('return_type')?.text ?? ''
        const mQname = addNode('method', mName, member, {
          parent: classQname,
          signature: compactSignature(`${mName}${params}${ret}`),
          exported,
          nested,
        })
        const mBody = member.childForFieldName('body')
        if (mBody) visit(mBody, mQname)
      } else if (
        member.type === 'public_field_definition'
        || member.type === 'field_definition'
      ) {
        const value = member.childForFieldName('value')
        if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          const fName = member.childForFieldName('name')?.text ?? '(anonymous)'
          const fQname = addNode('method', fName, member, {
            parent: classQname,
            signature: compactSignature(`${fName} = ${value.childForFieldName('parameters')?.text ?? '()'}`),
            exported,
            nested,
          })
          const b = value.childForFieldName('body')
          if (b) visit(b, fQname)
        }
      }
    }
  }

  /**
   * Handle a declaration node owned by `owner` — the file for a top-level or
   * exported declaration, the enclosing callable for a nested one.
   */
  const handleDeclaration = (node: TsNode, exported: boolean, owner = fileQname): boolean => {
    const nested = owner !== fileQname
    switch (node.type) {
      case 'class_declaration':
      case 'abstract_class_declaration': {
        handleClass(node, exported, owner)
        return true
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? '(anonymous)'
        const params = node.childForFieldName('parameters')?.text ?? '()'
        const ret = node.childForFieldName('return_type')?.text ?? ''
        const q = addNode('function', name, node, {
          parent: owner,
          signature: compactSignature(`${name}${params}${ret}`),
          exported,
          nested,
        })
        const body = node.childForFieldName('body')
        if (body) visit(body, q)
        return true
      }
      case 'interface_declaration': {
        const name = node.childForFieldName('name')?.text ?? '(anonymous)'
        addNode('interface', name, node, {
          parent: owner,
          signature: compactSignature(`interface ${name}`),
          exported,
        })
        return true
      }
      case 'type_alias_declaration': {
        const name = node.childForFieldName('name')?.text ?? '(anonymous)'
        addNode('type', name, node, {
          parent: owner,
          signature: compactSignature(`type ${name}`),
          exported,
        })
        return true
      }
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text ?? '(anonymous)'
        addNode('enum', name, node, {
          parent: owner,
          signature: compactSignature(`enum ${name}`),
          exported,
        })
        return true
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of childrenOfType(node, 'variable_declarator')) {
          const name = d.childForFieldName('name')?.text
          if (!name) continue
          const value = d.childForFieldName('value')
          if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
            declareFunction(d, name, value, exported, owner)
          } else {
            addNode('var', name, d, {
              parent: owner,
              signature: compactSignature(name),
              exported,
              nested,
            })
            if (value) visit(value, owner)
          }
        }
        return true
      }
      default:
        return false
    }
  }

  /** Record an import statement and its bound names. */
  const handleImport = (node: TsNode): void => {
    const sourceNode = node.childForFieldName('source')
    const spec = sourceNode?.namedChildren[0]?.text ?? sourceNode?.text?.replace(/['"]/g, '')
    if (!spec) return
    const line = node.startPosition.row + 1
    const clause = childrenOfType(node, 'import_clause')[0]
    if (!clause) {
      imports.push({ path, spec, resolvedPath: null, line, kind: 'side-effect' })
      return
    }
    for (const child of clause.namedChildren) {
      if (!child) continue
      if (child.type === 'identifier') {
        imports.push({
          path, spec, resolvedPath: null, line, kind: 'default',
          name: child.text, imported: 'default',
        })
      } else if (child.type === 'namespace_import') {
        const ns = child.namedChildren.find((c) => c !== null && c.type === 'identifier')
        if (ns) {
          imports.push({
            path, spec, resolvedPath: null, line, kind: 'namespace',
            name: ns.text, imported: '*',
          })
        }
      } else if (child.type === 'named_imports') {
        for (const specifier of childrenOfType(child, 'import_specifier')) {
          const orig = specifier.childForFieldName('name')?.text
            ?? specifier.namedChildren[0]?.text
          const alias = specifier.childForFieldName('alias')?.text
          const local = alias ?? orig
          if (!orig || !local) continue
          imports.push({
            path, spec, resolvedPath: null, line, kind: 'named',
            name: local, imported: orig,
          })
        }
      }
    }
  }

  const isDefaultExport = (node: TsNode): boolean => {
    for (let i = 0; i < node.childCount; i += 1) {
      const c = node.child(i)
      if (c && (c.type === 'default' || c.text === 'default')) return true
    }
    return false
  }

  const recordDefaultExport = (qname: string, line: number): void => {
    imports.push({
      path, spec: '', resolvedPath: path, line, kind: 'default-export',
      name: qname, imported: 'default',
    })
  }

  const markLocalExport = (orig: string, exposed: string, line: number): void => {
    for (const n of nodes) {
      if (n.kind !== 'file' && n.name === orig) n.exported = 1
    }
    imports.push({
      path, spec: path, resolvedPath: path, line, kind: 're-export-name',
      name: exposed, imported: orig,
    })
  }

  for (const top of root.namedChildren) {
    if (!top) continue
    if (top.type === 'import_statement') {
      handleImport(top)
      continue
    }
    if (top.type === 'export_statement') {
      const src = top.childForFieldName('source')
      if (src) {
        // `export ... from './x'` is an import edge for dependency purposes,
        // and additionally republishes names that importers will resolve here.
        const spec = src.namedChildren[0]?.text ?? src.text.replace(/['"]/g, '')
        if (spec) {
          imports.push({
            path,
            spec,
            resolvedPath: null,
            line: top.startPosition.row + 1,
            kind: 're-export',
          })
          const clause = childrenOfType(top, 'export_clause')[0]
          if (clause) {
            for (const specifier of childrenOfType(clause, 'export_specifier')) {
              const orig = specifier.childForFieldName('name')?.text
                ?? specifier.namedChildren[0]?.text
              const alias = specifier.childForFieldName('alias')?.text
              const ids = specifier.namedChildren.filter((c) => c !== null)
              const exposed = alias ?? (ids.length > 1 ? ids[1]?.text : orig)
              if (orig && exposed) reExports.push({ name: exposed, orig, spec })
            }
          } else if (childrenOfType(top, 'namespace_export').length === 0) {
            // `export * from './x'` republishes every name of the target.
            starReExports.push(spec)
          }
        }
        continue
      }
      const line = top.startPosition.row + 1
      if (isDefaultExport(top)) {
        const before = nodes.length
        for (const child of top.namedChildren) {
          if (!child) continue
          if (child.type === 'identifier') {
            const q = locals.get(child.text)
            if (q) recordDefaultExport(q, line)
          } else if (handleDeclaration(child, true) && nodes.length > before) {
            // The declaration itself is emitted first; its members follow.
            const added = nodes[before]
            if (added) recordDefaultExport(added.qname, line)
          }
        }
        continue
      }
      const clause = childrenOfType(top, 'export_clause')[0]
      if (clause) {
        for (const specifier of childrenOfType(clause, 'export_specifier')) {
          const orig = specifier.childForFieldName('name')?.text
            ?? specifier.namedChildren[0]?.text
          const alias = specifier.childForFieldName('alias')?.text
          const ids = specifier.namedChildren.filter((c) => c !== null)
          const exposed = alias ?? (ids.length > 1 ? ids[1]?.text : orig)
          if (orig && exposed) markLocalExport(orig, exposed, line)
        }
        continue
      }
      let handled = false
      for (const child of top.namedChildren) {
        if (!child) continue
        if (handleDeclaration(child, true)) handled = true
      }
      if (!handled) walkBody(top, fileQname)
      continue
    }
    if (!handleDeclaration(top, false)) walkBody(top, fileQname)
  }

  // Corroborated test-framework use marks the file as a test even when its
  // path does not match the conventional patterns.
  if (!fileIsTest && usesTestFramework(nodes, imports, calls)) {
    for (const n of nodes) n.isTest = 1
  }

  return { nodes, imports, calls, heritage, locals, reExports, starReExports }
}

/**
 * Parse and extract one file.
 * @param path - repo-relative file path.
 * @param lang - detected language.
 * @param source - full file text.
 * @returns The extracted structure, or undefined when the parser produced no tree.
 */
export async function extractFile(
  path: string,
  lang: Lang,
  source: string,
): Promise<FileExtract | undefined> {
  const parser = await parserFor(lang)
  const tree = parser.parse(source)
  if (!tree) return undefined
  try {
    return extractFromTree(path, lang, source, tree.rootNode)
  } finally {
    tree.delete()
  }
}
