/**
 * Shared extract types. Language-specific walkers and the query engine both
 * emit this shape; call resolution never sees a syntax tree.
 */
import type { GraphEdge, GraphNode, ImportRow } from '../db.ts'

/** A call site before its target has been resolved to a qualified name. */
export interface RawCall {
  /** Qualified name of the enclosing function/method, or the file for top level. */
  fromQname: string
  /** Bare callee name (`foo` in `foo()`, `run` in `a.b.run()`). */
  name: string
  /** Receiver expression text (`this.dep`, `obj`, `ns.deep`), or null for a plain call. */
  receiver: string | null
  /** True for `new X()`, which resolves against class nodes. */
  isConstruction: boolean
  line: number
}

/** Everything one file contributes to the graph before cross-file resolution. */
export interface FileExtract {
  nodes: GraphNode[]
  imports: ImportRow[]
  calls: RawCall[]
  /** INHERITS/IMPLEMENTS edges whose `dst` is still a bare type name. */
  heritage: GraphEdge[]
  /** Local declaration names -> qname, used as the innermost resolution scope. */
  locals: Map<string, string>
  /**
   * Names this file re-exports from elsewhere.
   * `name` is the exposed identifier; `orig` is the name in the source module.
   */
  reExports: Array<{ name: string; orig: string; spec: string }>
  /** Specifiers re-exported wholesale (`export * from './x'`). */
  starReExports: string[]
}

/** Optional cross-file facts the query engine can consult while extracting. */
export interface ExtractContext {
  /** File that declares `typeName` in the same package/crate as `fromPath`. */
  typeFile?: ((fromPath: string, typeName: string) => string | undefined) | undefined
}
