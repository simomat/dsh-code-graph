/**
 * Shared bookkeeping for the per-language import expanders.
 *
 * `expandJavaImports`, `expandGoImports` and `expandRustImports` each turn a
 * language's implicit visibility rules — a wildcard import, a Go package, a
 * `crate::` path — into the explicit named/namespace bindings the
 * language-agnostic call resolver understands. Those rules genuinely differ.
 * The scaffolding around them did not: three copies of a `seen` set, a dedup
 * guard seeded from the file's real imports, and two closures assembling the
 * same `ImportRow` shape. That half lives here once.
 *
 * The one substantive difference is the dedup key. Go and Rust bind a name
 * once per target file — two files in a Go package each contribute their own
 * `util` namespace row. Java binds a simple name once, full stop, because a
 * compilation unit cannot have two `Foo`s in scope. Hence the two key
 * functions rather than one.
 *
 * A binder never binds a name to the file it is expanding, and never shadows a
 * binding the file already declared itself.
 */
import type { ImportRow } from '../../db.ts'

/** How a binder decides two bindings are the same one. */
export type DedupKey = (kind: string, name: string, file: string) => string

/** One binding per (kind, local name, target file) — Go and Rust. */
export const byKindNameFile: DedupKey = (kind, name, file) => `${kind}\0${name}\0${file}`

/** One binding per local name, whatever it resolves to — Java. */
export const byName: DedupKey = (_kind, name) => name

/** Accumulates expansion rows for one file, deduped against each other and the file's own imports. */
export interface ImportBinder {
  /** Rows bound so far, in bind order. */
  readonly rows: ImportRow[]
  /**
   * Record the file's real imports as already bound, so expansion never
   * shadows one. A row without a `resolvedPath` claims a key no `bind*` call
   * can produce, so it constrains `byName` (where the name is the whole key)
   * and is inert under `byKindNameFile`.
   */
  seed(existing: readonly ImportRow[]): void
  /** Claim a dedup key. False when it was already taken. */
  claim(kind: string, name: string, file: string): boolean
  /** Bind `name` to a symbol of the same name in `file`. */
  bindNamed(name: string, file: string, spec: string, line: number, imported?: string): void
  /** Bind `local` to all of `file`, the way a TS namespace import does. */
  bindNamespace(local: string, file: string, spec: string, line: number): void
  /** Bind `file` for its effects only — no name enters scope. */
  bindSideEffect(name: string, file: string, spec: string, line: number): void
  /** Append a row that bypasses the dedup guard. */
  push(row: ImportRow): void
}

/**
 * @param path - repo-relative path of the file being expanded.
 * @param key - dedup strategy; `byKindNameFile` unless the language scopes
 * names per compilation unit.
 */
export function createImportBinder(path: string, key: DedupKey = byKindNameFile): ImportBinder {
  const rows: ImportRow[] = []
  const seen = new Set<string>()

  const claim = (kind: string, name: string, file: string): boolean => {
    const k = key(kind, name, file)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }

  return {
    rows,
    claim,
    seed(existing) {
      for (const imp of existing) {
        if (imp.name) claim(imp.kind, imp.name, imp.resolvedPath ?? '')
      }
    },
    bindNamed(name, file, spec, line, imported) {
      if (file === path || !claim('named', name, file)) return
      rows.push({
        path,
        spec,
        resolvedPath: file,
        line,
        kind: 'named',
        name,
        imported: imported ?? name,
      })
    },
    bindNamespace(local, file, spec, line) {
      if (file === path || !claim('namespace', local, file)) return
      rows.push({
        path,
        spec,
        resolvedPath: file,
        line,
        kind: 'namespace',
        name: local,
        imported: '*',
      })
    },
    bindSideEffect(name, file, spec, line) {
      if (file === path || !claim('side-effect', name, file)) return
      rows.push({ path, spec, resolvedPath: file, line, kind: 'side-effect', name })
    },
    push(row) {
      rows.push(row)
    },
  }
}
