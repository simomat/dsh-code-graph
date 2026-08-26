/**
 * The contract every query pack implements.
 *
 * Its own module so a language can be described without importing the registry
 * that lists its siblings: `java.ts`, `go.ts` and `rust.ts` depend on this file
 * and nothing else local, and `registry.ts` depends on all four.
 *
 * Defaults are Java-shaped because Java was the first grammar through the
 * engine — every optional hook exists to let a later language say where its
 * AST disagrees.
 */
import type { Node } from 'web-tree-sitter'
import type { ImportRow, NodeKind } from '../../db.ts'

export interface CallShape {
  name: string
  receiver: string | null
}

export interface QueryPack {
  query: string
  decodeImport?: (node: Node, path: string) => ImportRow[]
  /** Override Java-shaped `name`/`object` fields on call nodes. */
  decodeCall?: (node: Node) => CallShape | undefined
  /** Override Java-shaped `type` field on construction nodes. */
  decodeConstruction?: (node: Node) => CallShape | undefined
  isExported?: (node: Node, kind: NodeKind, name: string) => boolean
  classifyKind?: (node: Node, kind: NodeKind) => NodeKind
  /** Type a method belongs to (Go receiver), when it is not nested in the AST. */
  parentName?: (node: Node, kind: NodeKind) => string | undefined
  /** Receiver param name, so `s.m()` inside that method rewrites to `this.m()`. */
  receiverParam?: (node: Node, kind: NodeKind) => string | undefined
  /** Type name an `impl Trait for Type` (etc.) belongs to, when not nested in the AST. */
  heritageSrc?: (node: Node) => string | undefined
  /**
   * Signature for a declaration with no `parameters` field — types, mainly.
   * Return undefined to accept the generic `<keyword> <name>` composition.
   * It must never return the declaration's body: signatures are shown in
   * `code_find` output and indexed into FTS.
   */
  signature?: (node: Node, kind: NodeKind, name: string) => string | undefined
  /**
   * Receiver-qualified method names that are builtin/library noise in this
   * language, dropped when they do not resolve. Omitting it filters nothing
   * for that language rather than borrowing the TS/JS-family default, which is
   * wrong for every other grammar: `get`, `add`, `clear`, `parse` and friends
   * are ordinary user-defined methods in Go and Rust, and dropping them
   * discards real structure silently. `parse/noise.ts` does that lookup and is
   * the only reader of this field.
   */
  noiseMethods?: ReadonlySet<string>
}
