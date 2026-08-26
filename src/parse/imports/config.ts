/**
 * The resolver configuration: one repository's alias, package and per-language
 * indexes, plus the cache that avoids rebuilding them.
 *
 * Everything the language modules need to answer a question about a specifier
 * is loaded once, here, from the file universe. `resolve.ts` then reads it and
 * never touches the filesystem beyond the probe cache.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { type GoPackageIndex, loadGoPackages } from './go.ts'
import { type JavaTypeIndex, loadJavaTypes } from './java.ts'
import { type RustCrateIndex, loadRustCrates } from './rust.ts'
import { type AliasRule, loadAliases, loadPackageEntries, type TsResolverConfig } from './ts.ts'

export interface ResolverConfig extends TsResolverConfig {
  java?: JavaTypeIndex | undefined
  go?: GoPackageIndex | undefined
  rust?: RustCrateIndex | undefined
}

/**
 * Build the resolver configuration for one repository.
 * @param repoRoot - absolute repository root.
 * @param files - repo-relative paths of every indexed file.
 * @returns Configuration consumed by `resolveSpecifier`.
 */
export function buildResolverConfig(repoRoot: string, files: string[]): ResolverConfig {
  const aliases: AliasRule[] = []
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    aliases.push(...loadAliases(join(repoRoot, name)))
  }
  // Sorted once here, not once per specifier: longest prefix wins, and the
  // list never changes after construction.
  aliases.sort((a, b) => b.prefix.length - a.prefix.length)
  const java = loadJavaTypes(repoRoot, files)
  const go = loadGoPackages(repoRoot, files)
  const rust = loadRustCrates(repoRoot, files)
  return {
    repoRoot,
    aliases,
    packageEntries: loadPackageEntries(repoRoot, files),
    ...(java.types.size > 0 ? { java } : {}),
    ...(go.files.size > 0 ? { go } : {}),
    ...(rust.crateRoot.size > 0 ? { rust } : {}),
  }
}

/**
 * Files whose *contents* decide what {@link buildResolverConfig} produces:
 * every manifest it parses, plus every source file it scans for a package,
 * module or crate declaration.
 */
const CONFIG_MANIFEST_RE = /(^|\/)(go\.mod|Cargo\.toml|package\.json|tsconfig[^/]*\.json)$/
const CONFIG_SOURCE_RE = /\.(java|go|rs)$/

function isConfigInput(rel: string): boolean {
  return CONFIG_SOURCE_RE.test(rel) || CONFIG_MANIFEST_RE.test(rel)
}

interface ConfigCacheEntry {
  config: ResolverConfig
  /** Fingerprint of the config-relevant slice of the file universe. */
  fileKey: string
  /** Manifest path -> `mtime:size`. */
  manifests: Map<string, string>
}

const configCache = new Map<string, ConfigCacheEntry>()

/** Discard cached resolver configurations (call when a repository is released). */
export function clearResolverConfigCache(): void {
  configCache.clear()
}

/** FNV-1a over the config-relevant paths: catches an added or removed input. */
function configFileKey(files: string[]): string {
  let hash = 0x811c9dc5
  let count = 0
  for (const rel of files) {
    if (!isConfigInput(rel)) continue
    count += 1
    for (let i = 0; i < rel.length; i += 1) {
      hash ^= rel.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return `${count}:${hash >>> 0}`
}

/**
 * Stat every manifest the config parses.
 *
 * Manifests are few, and unlike `.java`/`.go`/`.rs` files they are not indexed,
 * so a change to one never reaches the caller's `changed` set. Stat'ing them is
 * what keeps a `go.mod` or `tsconfig.json` edit from being served from cache.
 */
function manifestStamps(repoRoot: string, files: string[]): Map<string, string> {
  const stamps = new Map<string, string>()
  const consider = (rel: string): void => {
    if (stamps.has(rel)) return
    try {
      const st = statSync(join(repoRoot, rel))
      stamps.set(rel, `${Math.floor(st.mtimeMs)}:${st.size}`)
    } catch {
      stamps.set(rel, 'absent')
    }
  }
  // Probed by name whether or not they are in the listing.
  for (const name of ['tsconfig.base.json', 'tsconfig.json', 'go.mod']) consider(name)
  for (const rel of files) {
    if (CONFIG_MANIFEST_RE.test(rel)) consider(rel)
  }
  return stamps
}

function sameStamps(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

/**
 * Resolver configuration for one repository, reusing the last one when nothing
 * it depends on has changed.
 *
 * Building it reads every `.java`/`.go`/`.rs` file in the repository, so doing
 * it again for a one-file edit costs more than the incremental re-index itself.
 * The cached config is reused only when the config-relevant file universe is
 * unchanged, no manifest has been touched, and nothing in `changed` is a config
 * input.
 *
 * @param repoRoot - absolute repository root.
 * @param files - repo-relative paths of every file in the repository.
 * @param changed - repo-relative paths known to have changed since the cached
 *   config was built. Omit to rebuild unconditionally (a full build).
 * @returns Configuration consumed by `resolveSpecifier`.
 */
export function resolverConfigFor(
  repoRoot: string,
  files: string[],
  changed?: Iterable<string>,
): ResolverConfig {
  const fileKey = configFileKey(files)
  const manifests = manifestStamps(repoRoot, files)
  const cached = changed === undefined ? undefined : configCache.get(repoRoot)
  if (cached && cached.fileKey === fileKey && sameStamps(cached.manifests, manifests)) {
    let invalidated = false
    for (const rel of changed as Iterable<string>) {
      if (isConfigInput(rel)) {
        invalidated = true
        break
      }
    }
    if (!invalidated) return cached.config
  }
  const config = buildResolverConfig(repoRoot, files)
  configCache.set(repoRoot, { config, fileKey, manifests })
  return config
}
