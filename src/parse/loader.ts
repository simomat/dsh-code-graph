/**
 * Lazy tree-sitter grammar loading.
 *
 * Deliberately WASM-only. The native `tree-sitter` bindings need `node-gyp-build`
 * at install time, which package managers block by default (denied explicitly in
 * `pnpm-workspace.yaml` `allowBuilds`), and a native ABI artifact also breaks
 * across Node major versions. The `.wasm` grammars shipped inside
 * `tree-sitter-typescript` need no build step and are ABI-independent.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import type { LangFamily } from '../config.ts'

const require_ = createRequire(import.meta.url)

/** Languages this plugin can extract structure from. */
export type Lang = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'java' | 'go' | 'rust'

interface GrammarOrigin {
  pkg: string
  file: string
}

function grammarOrigin(lang: Lang): GrammarOrigin {
  switch (lang) {
    case 'java':
      return { pkg: '@lumis-sh/wasm-java', file: 'tree-sitter-java.wasm' }
    case 'go':
      return { pkg: '@lumis-sh/wasm-go', file: 'tree-sitter-go.wasm' }
    case 'rust':
      return { pkg: '@lumis-sh/wasm-rust', file: 'tree-sitter-rust.wasm' }
    case 'tsx':
    case 'jsx':
      return { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' }
    default:
      // The TS grammar is a superset of JS; reusing it avoids a second download
      // and keeps one extractor query set for the whole family.
      return { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' }
  }
}

/** Which `Lang` members each user-selectable family covers. */
const FAMILY_LANGS: Record<LangFamily, readonly Lang[]> = {
  typescript: ['typescript', 'tsx', 'javascript', 'jsx'],
  java: ['java'],
  go: ['go'],
  rust: ['rust'],
}

/**
 * Narrow {@link langForPath} to the families a user enabled.
 *
 * A family left out is skipped before its grammar is ever asked for, so turning
 * one off costs neither the parse nor the WASM download.
 * @param families - enabled families; every family when omitted.
 * @returns A path-to-language mapping restricted to those families.
 */
export function langFilter(families?: readonly LangFamily[]): (path: string) => Lang | undefined {
  if (families === undefined) return langForPath
  const enabled = new Set<Lang>()
  for (const family of families) {
    for (const lang of FAMILY_LANGS[family] ?? []) enabled.add(lang)
  }
  return (path) => {
    const lang = langForPath(path)
    return lang !== undefined && enabled.has(lang) ? lang : undefined
  }
}

/** Map a file extension to a supported language, or undefined to skip it. */
export function langForPath(path: string): Lang | undefined {
  if (/(^|\/)(vendor|testdata|target)\//.test(path)) return undefined
  if (path.endsWith('.d.ts')) return 'typescript'
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'typescript'
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.jsx')) return 'jsx'
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript'
  if (path.endsWith('.java')) return 'java'
  if (path.endsWith('.go')) return 'go'
  if (path.endsWith('.rs')) return 'rust'
  return undefined
}

let initialized: Promise<void> | undefined
const languages = new Map<Lang, Language>()
const parsers = new Map<Lang, Parser>()

function grammarPath(lang: Lang): string {
  // Prefer the wasm file export when the package defines one; fall back to
  // locating the file next to package.json (tree-sitter-typescript layout).
  const { pkg, file } = grammarOrigin(lang)
  try {
    return require_.resolve(`${pkg}/${file}`)
  } catch {
    return join(dirname(require_.resolve(`${pkg}/package.json`)), file)
  }
}

/** Initialize the tree-sitter runtime exactly once per process. */
async function ensureInit(): Promise<void> {
  initialized ??= Parser.init()
  await initialized
}

/**
 * Get a parser configured for one language, loading its grammar on first use.
 * Parsers are cached and reused; tree-sitter parsers are single-threaded and
 * safe to reuse sequentially.
 * @param lang - the language whose parser is required.
 * @returns A ready parser bound to that grammar.
 */
export async function parserFor(lang: Lang): Promise<Parser> {
  await ensureInit()
  const cached = parsers.get(lang)
  if (cached) return cached

  let language = languages.get(lang)
  if (!language) {
    language = await Language.load(grammarPath(lang))
    languages.set(lang, language)
  }
  const parser = new Parser()
  parser.setLanguage(language)
  parsers.set(lang, parser)
  return parser
}

/**
 * Get the loaded Language object, needed to compile queries.
 * @param lang - the language whose grammar is required.
 * @returns The loaded grammar.
 */
export async function languageFor(lang: Lang): Promise<Language> {
  await parserFor(lang)
  const language = languages.get(lang)
  if (!language) throw new Error(`grammar not loaded: ${lang}`)
  return language
}

/** Release cached parsers and grammars (plugin teardown). */
export function disposeGrammars(): void {
  for (const p of parsers.values()) p.delete()
  parsers.clear()
  languages.clear()
}
