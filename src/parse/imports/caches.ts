/**
 * The import resolver's two process-global caches.
 *
 * Both are keyed by absolute path, so two repositories indexing at once never
 * read each other's entries; `index/manager.ts` documents what that costs when
 * one build's clear lands mid-way through another's.
 *
 * The third cache — the resolver configuration itself — is not here. Its
 * entries are only meaningful next to the invalidation rule that decides when
 * one may be reused, so it lives in `config.ts` with `resolverConfigFor`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Extensions probed when a specifier omits one, in resolution order. */
const EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.d.ts',
  '.js', '.jsx', '.mjs', '.cjs',
]

/**
 * Read-through cache shared with the indexer's parse pass.
 *
 * The Java/Go/Rust loaders read every source file of their language to build
 * the resolver config; pass 1 of the build then reads the very same files to
 * parse them. Handing the text over instead of re-reading it halves the I/O
 * for those repositories. Entries are handed out once and dropped, and the
 * cache stops growing past `SOURCE_CACHE_MAX_BYTES` so a large repository does
 * not trade I/O for unbounded memory.
 */
const SOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const sourceCache = new Map<string, { text: string; mtimeMs: number; size: number }>()
let sourceCacheBytes = 0

/** Discard cached source text (call before a build or re-index). */
export function clearSourceCache(): void {
  sourceCache.clear()
  sourceCacheBytes = 0
}

/**
 * Take source text read earlier in this build, if it is still current.
 * @param abs - absolute file path.
 * @param mtimeMs - the caller's freshly stat'd mtime, floored to milliseconds.
 * @param size - the caller's freshly stat'd byte size.
 * @returns The cached text, removed from the cache, or undefined.
 */
export function takeCachedSource(abs: string, mtimeMs: number, size: number): string | undefined {
  const hit = sourceCache.get(abs)
  if (!hit) return undefined
  sourceCache.delete(abs)
  sourceCacheBytes -= hit.text.length
  // A file rewritten between the config load and the parse pass must be re-read,
  // or its stored hash and mtime would describe different content.
  if (hit.mtimeMs !== mtimeMs || hit.size !== size) return undefined
  return hit.text
}

/** Read a repo file, caching the text for the parse pass that follows. */
export function readSource(repoRoot: string, rel: string): string {
  const abs = join(repoRoot, rel)
  const text = readFileSync(abs, 'utf8')
  if (sourceCacheBytes + text.length <= SOURCE_CACHE_MAX_BYTES) {
    try {
      const st = statSync(abs)
      sourceCache.set(abs, { text, mtimeMs: Math.floor(st.mtimeMs), size: st.size })
      sourceCacheBytes += text.length
    } catch {
      // Unstattable: just do not cache it.
    }
  }
  return text
}

/**
 * Existence-probe cache.
 *
 * Import resolution probes many candidate paths per specifier (extension and
 * index-file variants), and the same candidates recur across thousands of
 * files. Caching the probe cut resolution from 2.7s to well under a second on
 * a 2.7k-file monorepo. Cleared whenever a build starts so a new or deleted
 * file is never masked by a stale negative.
 *
 * Process-global, not per-repo: keys are absolute paths, so repositories never
 * read each other's entries, and a clear triggered by one repo's build only
 * costs another concurrent build some re-probing.
 */
const probeCache = new Map<string, string | undefined>()

/** Discard cached filesystem probes (call before a build or re-index). */
export function clearProbeCache(): void {
  probeCache.clear()
}

/** Probe one absolute path for a real file, trying extensions and index files. */
export function probeFile(base: string): string | undefined {
  const cached = probeCache.get(base)
  if (cached !== undefined || probeCache.has(base)) return cached
  const found = probeFileUncached(base)
  probeCache.set(base, found)
  return found
}

function probeFileUncached(base: string): string | undefined {
  try {
    if (existsSync(base) && statSync(base).isFile()) return base
  } catch {
    // fall through to extension probing
  }
  // A `.js` specifier commonly refers to a `.ts` source in TS projects.
  const jsRewrite = base.match(/\.([cm]?)js$/)
  if (jsRewrite) {
    const stem = base.slice(0, base.length - (jsRewrite[0]?.length ?? 0))
    for (const ext of [`.${jsRewrite[1] ?? ''}ts`, '.ts', '.tsx']) {
      const cand = stem + ext
      if (existsSync(cand)) return cand
    }
  }
  for (const ext of EXTENSIONS) {
    const cand = base + ext
    if (existsSync(cand)) return cand
  }
  for (const ext of EXTENSIONS) {
    const cand = join(base, 'index' + ext)
    if (existsSync(cand)) return cand
  }
  return undefined
}
