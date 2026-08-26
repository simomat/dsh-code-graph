/**
 * Turn raw call sites into graph edges with honest confidence.
 *
 * Resolution order, highest confidence first:
 *   1.00  imported binding  — the specifier resolved to a file that exports the name
 *   0.90  same-file declaration
 *   0.80  `this.m()` inside a class whose own/inherited member is `m`
 *   0.50  globally unique name across the repository
 *   0.30  ambiguous or unknown -> REFERENCES to a bare name, resolved = 0
 *
 * Nothing is ever fabricated: an unresolvable target stays a bare name with
 * `resolved = 0`, so a consumer can tell a real edge from a guess. Every tool
 * surfaces this, which is what lets the agent know when to fall back to grep.
 */
import type { GraphEdge, GraphNode } from '../db.ts'
import type { FileExtract, RawCall } from './types.ts'

/** Exported-symbol index: file path -> exported name -> qualified name. */
export type ExportIndex = Map<string, Map<string, string>>

/** Global name index: bare name -> every qualified name carrying it. */
export type NameIndex = Map<string, string[]>

export interface ResolutionInput {
  /** Repo-relative file path being resolved. */
  path: string
  extract: FileExtract
  /** Import specifier -> resolved repo-relative path, for this file. */
  resolvedImports: Map<string, string>
  exportIndex: ExportIndex
  nameIndex: NameIndex
  /** Class qname -> member names, for `this.m()` resolution. */
  classMembers: Map<string, Set<string>>
  /** Class qname -> resolved base class qnames (INHERITS). */
  classParents?: Map<string, string[]> | undefined
  /**
   * Node kind by qname, for constructor-vs-call filtering. Required: it covers
   * every node in the graph, so a miss here means the qname is genuinely not a
   * declaration — there is no per-file fallback worth scanning for.
   */
  kinds: Map<string, GraphNode['kind']>
  /**
   * Receiver-qualified names to drop when they do not resolve, for this file's
   * language. Passed in rather than looked up: the lists are per-language data
   * owned by the query packs (`parse/noise.ts` maps a `Lang` to one), and
   * resolution deliberately knows nothing about grammars, which is what
   * `parse/types.ts` claims for it. An empty set disables the filter.
   */
  noise: ReadonlySet<string>
}

/**
 * Build the exported-symbol index from every node in the graph.
 * @param nodes - all structural nodes.
 * @returns File path -> exported name -> qualified name.
 */
export function buildExportIndex(nodes: Iterable<GraphNode>): ExportIndex {
  const index: ExportIndex = new Map()
  for (const n of nodes) {
    if (n.kind === 'file' || n.exported !== 1) continue
    // Only top-level symbols are importable; methods are reached via their class.
    if (n.kind === 'method') continue
    let bucket = index.get(n.path)
    if (!bucket) {
      bucket = new Map()
      index.set(n.path, bucket)
    }
    bucket.set(n.name, n.qname)
  }
  return index
}

/** One file's re-export declaration, as stored in the imports table. */
export interface ReExportRow {
  /** File doing the re-exporting. */
  path: string
  /** Resolved target file the name comes from. */
  target: string
  /** Exposed name, or `*` for a star re-export. */
  name: string
  /** Name in the source module; defaults to `name` when omitted. */
  imported?: string | undefined
}

/**
 * Propagate re-exported names through barrel files.
 *
 * `export { defineTool } from './schema.ts'` must make `defineTool` resolvable
 * through the barrel's path, or every importer of a package entry point
 * degrades to a low-confidence global-name guess. Measured on this harness:
 * without this pass only 2 of 40 genuine `defineTool` callers resolved
 * confidently, and the rest were demoted to 0.5 and filtered out of caller
 * counts.
 *
 * Iterated to a fixed point (bounded) because barrels chain: a package index
 * re-exports a subdirectory index which re-exports the defining module.
 * @param index - the direct export index, extended in place.
 * @param reExports - every recorded re-export row.
 * @param maxRounds - iteration bound protecting against re-export cycles.
 */
export function propagateReExports(
  index: ExportIndex,
  reExports: readonly ReExportRow[],
  maxRounds = 6,
): void {
  for (let round = 0; round < maxRounds; round += 1) {
    let changed = false
    for (const row of reExports) {
      const source = index.get(row.target)
      if (!source) continue
      let bucket = index.get(row.path)
      if (!bucket) {
        bucket = new Map()
        index.set(row.path, bucket)
      }
      if (row.name === '*' || row.imported === '*') {
        for (const [name, qname] of source) {
          if (!bucket.has(name)) {
            bucket.set(name, qname)
            changed = true
          }
        }
      } else {
        const sourceName = row.imported && row.imported !== '*' ? row.imported : row.name
        const qname = source.get(sourceName)
        if (qname !== undefined && !bucket.has(row.name)) {
          bucket.set(row.name, qname)
          changed = true
        }
      }
    }
    if (!changed) return
  }
}

/**
 * Build the global bare-name index used for the low-confidence fallback.
 * @param nodes - all structural nodes.
 * @returns Bare name -> qualified names.
 */
export function buildNameIndex(nodes: Iterable<GraphNode>): NameIndex {
  const index: NameIndex = new Map()
  for (const n of nodes) {
    if (n.kind === 'file') continue
    const list = index.get(n.name)
    if (list) list.push(n.qname)
    else index.set(n.name, [n.qname])
  }
  return index
}

/**
 * Build a class -> member-name lookup for `this.m()` resolution.
 * @param nodes - all structural nodes.
 * @returns Class qualified name -> set of member names.
 */
export function buildClassMembers(nodes: Iterable<GraphNode>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const n of nodes) {
    if (n.kind !== 'method' || !n.parent) continue
    let set = map.get(n.parent)
    if (!set) {
      set = new Set()
      map.set(n.parent, set)
    }
    set.add(n.name)
  }
  return map
}

/** Find the class qname enclosing a method qname, if any. */
function enclosingClass(fromQname: string, classMembers: Map<string, Set<string>>): string | undefined {
  const cut = fromQname.lastIndexOf('.')
  if (cut < 0) return undefined
  const candidate = fromQname.slice(0, cut)
  return classMembers.has(candidate) ? candidate : undefined
}

interface ImportBinding {
  file: string
  exportName: string
}

const SKIP_BIND_KINDS = new Set([
  'side-effect', 're-export', 're-export-name', 're-export-star', 'default-export',
  'wildcard', 'static-star', 'dot',
])

/** Map local names (and namespace aliases) from this file's import rows. */
function bindImports(
  extract: FileExtract,
  resolvedImports: Map<string, string>,
): { importedFrom: Map<string, ImportBinding>; namespaces: Map<string, string[]> } {
  const importedFrom = new Map<string, ImportBinding>()
  const namespaces = new Map<string, string[]>()
  for (const imp of extract.imports) {
    if (SKIP_BIND_KINDS.has(imp.kind)) continue
    const target = imp.resolvedPath || (imp.spec ? resolvedImports.get(imp.spec) : undefined) || undefined
    if (!target) continue
    if (
      (imp.kind === 'namespace' || (imp.kind === 'alias' && (imp.imported === '*' || imp.imported == null)))
      && imp.name
    ) {
      const list = namespaces.get(imp.name) ?? []
      if (!list.includes(target)) list.push(target)
      namespaces.set(imp.name, list)
      continue
    }
    if (imp.name) {
      const exportName = imp.kind === 'default' ? 'default' : (imp.imported ?? imp.name)
      if (!importedFrom.has(imp.name)) {
        importedFrom.set(imp.name, { file: target, exportName })
      }
    }
  }
  return { importedFrom, namespaces }
}

function lookupMemberInFile(
  file: string,
  name: string,
  exportIndex: ExportIndex,
  classMembers: Map<string, Set<string>>,
): string | undefined {
  const exports = exportIndex.get(file)
  if (!exports) return undefined
  for (const qname of exports.values()) {
    if (classMembers.get(qname)?.has(name)) return `${qname}.${name}`
  }
  return undefined
}

function isTypeKind(kind: GraphNode['kind'] | undefined): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'type'
}

function lookupImported(
  localName: string,
  importedFrom: Map<string, ImportBinding>,
  exportIndex: ExportIndex,
  classMembers?: Map<string, Set<string>>,
): string | undefined {
  const b = importedFrom.get(localName)
  if (!b) return undefined
  const direct = exportIndex.get(b.file)?.get(b.exportName)
  if (direct) return direct
  if (!classMembers) return undefined
  const exports = exportIndex.get(b.file)
  if (!exports) return undefined
  for (const qname of exports.values()) {
    if (classMembers.get(qname)?.has(b.exportName)) return `${qname}.${b.exportName}`
  }
  return undefined
}

/** Walk own then inherited members for `this.m()`. */
function findThisMember(
  cls: string,
  name: string,
  classMembers: Map<string, Set<string>>,
  classParents: Map<string, string[]>,
): string | undefined {
  const seen = new Set<string>()
  const stack = [cls]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    if (classMembers.get(current)?.has(name)) return `${current}.${name}`
    for (const parent of classParents.get(current) ?? []) stack.push(parent)
    if (seen.size > 16) break
  }
  return undefined
}

/**
 * Resolve one file's call sites into edges.
 * @param input - the file's extract plus the global indexes.
 * @returns Edges ready for insertion, each carrying resolution confidence.
 */
export function resolveCalls(input: ResolutionInput): GraphEdge[] {
  const {
    path, extract, resolvedImports, exportIndex, nameIndex, classMembers, kinds, noise,
    classParents = new Map(),
  } = input
  const edges: GraphEdge[] = []
  const { importedFrom, namespaces } = bindImports(extract, resolvedImports)

  const emit = (call: RawCall, dst: string, resolved: number, confidence: number, kind: GraphEdge['kind']): void => {
    edges.push({
      kind,
      src: call.fromQname,
      dst,
      path,
      line: call.line,
      resolved,
      confidence,
    })
  }

  for (const call of extract.calls) {
    // 1. imported binding (plain call or `ns.foo()` through a namespace import)
    if (call.receiver === null) {
      const qname = lookupImported(call.name, importedFrom, exportIndex, classMembers)
      if (qname) {
        emit(call, qname, 1, 1.0, 'CALLS')
        continue
      }
    } else {
      const nsFiles = namespaces.get(call.receiver)
      if (nsFiles) {
        let qname: string | undefined
        for (const nsFile of nsFiles) {
          qname = exportIndex.get(nsFile)?.get(call.name)
            ?? lookupMemberInFile(nsFile, call.name, exportIndex, classMembers)
          if (qname) break
        }
        if (qname) {
          emit(call, qname, 1, 1.0, 'CALLS')
          continue
        }
      }
      // Type qualifier: `Helper.doubleIt()` / `Service.run()` where Helper is a type.
      if (call.receiver !== 'this' && call.receiver !== 'super') {
        const typeQname = lookupImported(call.receiver, importedFrom, exportIndex, classMembers)
          ?? extract.locals.get(call.receiver)
        if (typeQname) {
          const kind = kinds.get(typeQname)
          if (isTypeKind(kind) && classMembers.get(typeQname)?.has(call.name)) {
            const viaImport = importedFrom.has(call.receiver)
            emit(call, `${typeQname}.${call.name}`, 1, viaImport ? 1.0 : 0.9, 'CALLS')
            continue
          }
        }
      }
    }

    // 2. same-file declaration
    const local = extract.locals.get(call.name)
    if (local && call.receiver === null) {
      const kind = kinds.get(local)
      const constructionOk = !call.isConstruction || kind === 'class'
      const callOk = call.isConstruction || kind !== 'class'
      if (constructionOk && callOk) {
        emit(call, local, 1, 0.9, 'CALLS')
        continue
      }
    }

    // 3. this.m() / super.m() within the enclosing class or an ancestor
    if (call.receiver === 'this' || call.receiver === 'super') {
      const cls = enclosingClass(call.fromQname, classMembers)
      if (cls) {
        const member = findThisMember(cls, call.name, classMembers, classParents)
        if (member) {
          emit(call, member, 1, 0.8, 'CALLS')
          continue
        }
      }
    }

    // 4. globally unique bare name
    const candidates = nameIndex.get(call.name)
    if (candidates && candidates.length === 1 && candidates[0]) {
      const dst = candidates[0]
      const kind = kinds.get(dst)
      const constructionOk = !call.isConstruction || kind === 'class'
      const callOk = call.isConstruction || kind !== 'class'
      if (constructionOk && callOk) {
        emit(call, dst, 1, 0.5, 'CALLS')
        continue
      }
    }

    // 5. unresolved. A receiver-qualified builtin (`arr.push` in TS,
    // `err.Error()` in Go) is noise, not structure, and is dropped entirely —
    // per this language's list, not the TS one. Everything else is kept with
    // the evidence intact and marked honestly as unresolved.
    if (call.receiver !== null && noise.has(call.name)) continue
    emit(call, call.name, 0, 0.3, call.receiver ? 'REFERENCES' : 'CALLS')
  }

  // Heritage edges resolve against imported and local type names.
  edges.push(...heritageEdges(extract, importedFrom, exportIndex, nameIndex, classMembers))

  return edges
}

/** Resolve `extends` / `implements` targets against imports, locals, then names. */
function heritageEdges(
  extract: FileExtract,
  importedFrom: Map<string, ImportBinding>,
  exportIndex: ExportIndex,
  nameIndex: NameIndex,
  classMembers: Map<string, Set<string>>,
): GraphEdge[] {
  const edges: GraphEdge[] = []
  for (const h of extract.heritage) {
    const qname = lookupImported(h.dst, importedFrom, exportIndex, classMembers) ?? extract.locals.get(h.dst)
    if (qname) {
      edges.push({ ...h, dst: qname, resolved: 1, confidence: 1.0 })
      continue
    }
    const candidates = nameIndex.get(h.dst)
    if (candidates && candidates.length === 1 && candidates[0]) {
      edges.push({ ...h, dst: candidates[0], resolved: 1, confidence: 0.5 })
      continue
    }
    edges.push({ ...h, resolved: 0, confidence: 0.3 })
  }
  return edges
}

/**
 * Resolve one file's heritage edges, without resolving its calls.
 *
 * `this.m()` resolution needs a class-parent map, which is itself built from
 * resolved `INHERITS` edges — so the edge rewrite has to resolve heritage for
 * every file before it can resolve calls for any of them. Heritage does not
 * depend on that map, so this is all the work that first pass actually needs;
 * running full call resolution to harvest it doubled every rebuild.
 *
 * @param input - the same input `resolveCalls` takes; `classParents`, `kinds`
 *   and `noise` are unused, and this runs before `classParents` exists.
 * @returns This file's INHERITS and IMPLEMENTS edges, resolution marked.
 */
export function resolveHeritage(input: ResolutionInput): GraphEdge[] {
  const { extract, resolvedImports, exportIndex, nameIndex, classMembers } = input
  if (extract.heritage.length === 0) return []
  const { importedFrom } = bindImports(extract, resolvedImports)
  return heritageEdges(extract, importedFrom, exportIndex, nameIndex, classMembers)
}
