/**
 * Which language gets which query pack.
 *
 * Adding a language is a wasm grammar + a `.scm` query (as a string in the
 * language's module so `tsc` ships it) + optional import/package decoders. The
 * engine maps `@definition.*` / `@call` / `@construction` / `@heritage.*`
 * captures; it does not grow a new AST walker. Since `q23` that is also one
 * new module plus one row here, rather than a fourth edit to a 600-line file:
 * a language module imports `pack.ts` (and `ast.ts`) and never its siblings,
 * so this is the only place the three meet.
 */
import type { Lang } from '../loader.ts'
import { GO_PACK } from './go.ts'
import { JAVA_PACK } from './java.ts'
import type { QueryPack } from './pack.ts'
import { RUST_PACK } from './rust.ts'

const PACKS: Partial<Record<Lang, QueryPack>> = {
  java: JAVA_PACK,
  go: GO_PACK,
  rust: RUST_PACK,
}

/** Query pack for a language, or undefined when the TS-family walker applies. */
export function queryPack(lang: Lang): QueryPack | undefined {
  return PACKS[lang]
}
