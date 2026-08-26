/**
 * Which receiver-qualified method names are builtin/library noise, by language.
 *
 * This is the *lookup* side of the per-language noise lists. The lists
 * themselves stay where `m20` put them — on each `QueryPack`, next to the
 * grammar they describe — and this module is the one place that asks the
 * registry for one, so that call resolution never has to. Resolution takes the
 * finished set as data (`ResolutionInput.noise`) and stays free of any
 * dependency on grammars, packs or the wasm loader.
 */
import { queryPack } from './langs/registry.ts'
import type { Lang } from './loader.ts'

/**
 * TS/JS-family method names that are overwhelmingly builtin/library calls
 * rather than project structure. Measured on a 2.7k-file monorepo, unresolved
 * REFERENCES were led by `push`/`get`/`toBe`/`join` — 37.8k edges, none
 * resolvable and none carrying structural signal, at ~40% of total database
 * size. Dropping them costs no answer any tool can give and shrinks the index
 * substantially.
 *
 * This list is the *default*, not the rule: that measurement predates Go and
 * Rust support, where `get`, `add`, `clear`, `close` and `parse` are ordinary
 * user-defined methods. Every query-pack language supplies its own list via
 * `QueryPack.noiseMethods`; see `noiseFor`.
 */
const JS_NOISE_METHODS: ReadonlySet<string> = new Set([
  // collection / object builtins
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
  'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
  'sort', 'reverse', 'includes', 'indexOf', 'flat', 'flatMap', 'at', 'fill',
  'get', 'set', 'has', 'delete', 'add', 'clear', 'keys', 'values', 'entries',
  // string / number / json
  'toString', 'valueOf', 'trim', 'split', 'replace', 'replaceAll', 'match',
  'startsWith', 'endsWith', 'padStart', 'padEnd', 'toLowerCase', 'toUpperCase',
  'stringify', 'parse', 'toFixed', 'repeat', 'substring', 'charAt', 'normalize',
  // promise / async
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race', 'allSettled',
  // test-framework assertion chains
  'toBe', 'toEqual', 'toThrow', 'toContain', 'toMatch', 'toHaveBeenCalled',
  'toBeUndefined', 'toBeDefined', 'toBeNull', 'toBeTruthy', 'toBeFalsy',
  'expect', 'mockResolvedValue', 'mockReturnValue', 'mockImplementation',
  // Java / common stdlib
  'println', 'printf', 'print', 'equals', 'hashCode', 'getClass',
  'wait', 'notify', 'notifyAll', 'iterator', 'close', 'flush',
])

const EMPTY_NOISE: ReadonlySet<string> = new Set()

/**
 * The noise list that applies to one language.
 *
 * A language with no query pack is the TS/JS-family walker, which is what the
 * default list was measured on; so is a path with no language at all. A pack
 * that declares no list of its own opts out of noise filtering entirely —
 * keeping an unresolved call as an honest `REFERENCES` edge is always the safe
 * direction.
 *
 * @param lang - the file's language, or undefined when it has none.
 * @returns The names to drop for that file.
 */
export function noiseFor(lang: Lang | undefined): ReadonlySet<string> {
  if (!lang) return JS_NOISE_METHODS
  const pack = queryPack(lang)
  if (!pack) return JS_NOISE_METHODS
  return pack.noiseMethods ?? EMPTY_NOISE
}
