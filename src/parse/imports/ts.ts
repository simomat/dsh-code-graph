/**
 * TS/JS import specifier -> repo-relative file path.
 *
 * This is the precision lever. `code-review-graph` matches call targets by bare
 * name and then patches up the damage with per-language heuristic resolvers;
 * for TS/JS the import graph is statically resolvable, so resolving specifiers
 * properly here removes most of that guesswork downstream.
 *
 * Handles: relative paths, `tsconfig.json` `paths`/`baseUrl` aliases (verified
 * essential — this harness maps scoped wildcards onto vendored source dirs),
 * and workspace packages via their `package.json` entry points.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve as resolvePath } from 'node:path'
import { probeFile } from './caches.ts'

export interface AliasRule {
  /** Prefix before a `*` wildcard, or the whole literal pattern. */
  prefix: string
  /** True when the pattern ended in `*`. */
  wildcard: boolean
  /** Absolute candidate targets, wildcard placeholder preserved. */
  targets: string[]
}

/**
 * The part of the resolver configuration these two resolvers read.
 *
 * Declared here rather than taken from `config.ts` so this module does not
 * depend on the one that builds it — `config.ts` calls the loaders below.
 */
export interface TsResolverConfig {
  repoRoot: string
  /** Alias rules, pre-sorted longest-prefix-first — `resolveTsSpecifier` relies on the order. */
  aliases: AliasRule[]
  /** Package name -> absolute entry file, for workspace-local packages. */
  packageEntries: Map<string, string>
}

/** Strip JSON comments and trailing commas so tsconfig files parse. */
function parseJsonc(text: string): unknown {
  const withoutComments = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (m, line, block) =>
      line || block ? '' : m)
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(withoutTrailingCommas) as unknown
  } catch {
    return undefined
  }
}

function readJsonc(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseJsonc(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Load `paths` aliases from a tsconfig, following `extends` one level up the
 * chain so a monorepo's base config is honored.
 * @param configPath - absolute tsconfig path to read.
 * @param seen - guard against `extends` cycles.
 * @returns Alias rules with absolute targets.
 */
export function loadAliases(configPath: string, seen = new Set<string>()): AliasRule[] {
  if (seen.has(configPath) || !existsSync(configPath)) return []
  seen.add(configPath)
  const json = readJsonc(configPath)
  if (!json) return []

  const rules: AliasRule[] = []
  const extendsValue = json['extends']
  if (typeof extendsValue === 'string') {
    const parentPath = extendsValue.startsWith('.')
      ? resolvePath(dirname(configPath), extendsValue)
      : undefined
    if (parentPath) {
      const withExt = parentPath.endsWith('.json') ? parentPath : `${parentPath}.json`
      rules.push(...loadAliases(withExt, seen))
    }
  }

  const compilerOptions = json['compilerOptions']
  if (typeof compilerOptions !== 'object' || compilerOptions === null) return rules
  const co = compilerOptions as Record<string, unknown>
  const baseUrl = typeof co['baseUrl'] === 'string' ? co['baseUrl'] : '.'
  const base = resolvePath(dirname(configPath), baseUrl)
  const paths = co['paths']
  if (typeof paths !== 'object' || paths === null) return rules

  for (const [pattern, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const wildcard = pattern.endsWith('*')
    const prefix = wildcard ? pattern.slice(0, -1) : pattern
    const targets = value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => resolvePath(base, v))
    if (targets.length > 0) rules.push({ prefix, wildcard, targets })
  }
  return rules
}

/**
 * Discover workspace package entry points so cross-package imports resolve.
 * @param repoRoot - absolute repository root.
 * @param files - repo-relative paths of every indexed file.
 * @returns Map of package name to its absolute entry file.
 */
export function loadPackageEntries(repoRoot: string, files: string[]): Map<string, string> {
  const entries = new Map<string, string>()
  const manifests = files.filter((f) => f.endsWith('package.json'))
  for (const rel of manifests) {
    const abs = join(repoRoot, rel)
    const json = readJsonc(abs)
    const name = json?.['name']
    if (typeof name !== 'string') continue
    const dir = dirname(abs)
    // Prefer a source entry over a built one: the graph indexes sources.
    const candidates: string[] = []
    const push = (v: unknown): void => {
      if (typeof v === 'string') candidates.push(v)
    }
    const exportsField = json?.['exports']
    if (typeof exportsField === 'object' && exportsField !== null) {
      const root = (exportsField as Record<string, unknown>)['.']
      if (typeof root === 'string') push(root)
      else if (typeof root === 'object' && root !== null) {
        const r = root as Record<string, unknown>
        push(r['types'])
        push(r['default'])
        push(r['import'])
      }
    }
    push(json?.['main'])
    push(json?.['module'])
    push(json?.['types'])
    candidates.push('src/index.ts', 'index.ts', 'src/index.js', 'index.js')

    for (const c of candidates) {
      const target = probeFile(resolvePath(dir, c))
      if (target) {
        entries.set(name, target)
        break
      }
    }
  }
  return entries
}

/** Repo-relative form of an absolute path, or undefined when it escapes the repo. */
function toRelative(repoRoot: string, abs: string): string | undefined {
  const rel = relative(repoRoot, abs)
  if (rel.startsWith('..') || rel.startsWith('/')) return undefined
  return normalize(rel).split('\\').join('/')
}

/**
 * Resolve a `./`-style specifier against the importing file's directory.
 *
 * Every language whose specifiers can be relative goes through here, which is
 * why it is separate from {@link resolveTsSpecifier}: a relative specifier that
 * does not exist resolves to nothing, and must not fall through to the alias
 * and workspace-package lookups below.
 *
 * @param spec - the raw specifier text, starting with `.`.
 * @param fromPath - repo-relative path of the importing file.
 * @param repoRoot - absolute repository root.
 * @returns Repo-relative target path, or undefined.
 */
export function resolveRelativeSpecifier(
  spec: string,
  fromPath: string,
  repoRoot: string,
): string | undefined {
  const abs = resolvePath(dirname(join(repoRoot, fromPath)), spec)
  const hit = probeFile(abs)
  return hit ? toRelative(repoRoot, hit) : undefined
}

/**
 * Resolve a bare specifier through tsconfig aliases, then workspace packages.
 * @param spec - the raw specifier text.
 * @param config - the TS/JS half of the resolver configuration.
 * @returns Repo-relative target path, or undefined for an external module.
 */
export function resolveTsSpecifier(spec: string, config: TsResolverConfig): string | undefined {
  const { repoRoot } = config

  // tsconfig path aliases: longest prefix wins, matching tsc's own rule.
  // `config.aliases` is sorted at construction; sorting here would repeat that
  // work once per import specifier, tens of thousands of times per build.
  for (const rule of config.aliases) {
    if (rule.wildcard ? spec.startsWith(rule.prefix) : spec === rule.prefix) {
      const rest = rule.wildcard ? spec.slice(rule.prefix.length) : ''
      for (const target of rule.targets) {
        const candidate = target.includes('*')
          ? target.replace('*', rest)
          : rule.wildcard ? join(target, rest) : target
        const hit = probeFile(candidate)
        if (hit) return toRelative(repoRoot, hit)
      }
    }
  }

  // Workspace packages, including deep subpath imports.
  const direct = config.packageEntries.get(spec)
  if (direct) return toRelative(repoRoot, direct)
  for (const [name, entry] of config.packageEntries) {
    if (spec.startsWith(`${name}/`)) {
      const subpath = spec.slice(name.length + 1)
      const pkgDir = dirname(entry)
      const hit = probeFile(resolvePath(pkgDir, subpath))
        ?? probeFile(resolvePath(pkgDir, '..', subpath))
        ?? probeFile(resolvePath(pkgDir, 'src', subpath))
      if (hit) return toRelative(repoRoot, hit)
    }
  }

  return undefined
}
