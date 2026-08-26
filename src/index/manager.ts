/**
 * Index lifecycle: one graph per repository, built lazily, kept fresh.
 *
 * A tool call must never block a turn on a cold build, so the first call for a
 * repository starts a background build and returns `status: 'building'`. That
 * build belongs to the manager, not to the call that triggered it: a caller's
 * signal cancels *waiting* for the build, never the build itself, so a repo
 * too large to finish inside the grace period still converges instead of
 * restarting from scratch on every aborted call. Only `dispose()` aborts it.
 * Once ready, each call runs a validation pass (git HEAD + working-tree status,
 * falling back to mtime/size when git is absent) and re-indexes just the
 * affected files. The per-repo mutex serializes build and refresh for *one*
 * repository, so that repo's DatabaseSync is never used concurrently.
 *
 * It says nothing about the parse layer: `parsers` and `languages`
 * (`parse/loader.ts`), `queryCache` (`parse/query-extract.ts`) and
 * `probeCache` (`parse/imports/caches.ts`) are module-level globals shared by
 * every repository in the process. Two repos indexing at once is safe anyway,
 * because `parser.parse()` and `query.matches()` are synchronous — no two
 * builds interleave inside one — and because those caches are keyed by
 * language or by absolute path, so entries never cross repositories. The one
 * observable interaction is `clearProbeCache()` at another repo's build start
 * discarding cached filesystem probes mid-build, which costs re-probes and
 * nothing more.
 */
import type { GraphDb } from '../db.ts'
import { abortReason, isAbortError, throwIfAborted } from '../abort.ts'
import { canonicalizePath, canonicalizeRepoRoot } from '../repo.ts'
import { DEFAULT_INDEX_LIMITS, fullBuild, incrementalBuild, type IncrementalResult, type IndexLimits } from './build.ts'
import { gitDirtyPaths, gitState } from './gitscan.ts'

export interface Freshness {
  status: 'ready' | 'building' | 'stale'
  head: string | null
  /** Files known to have changed since the last index pass. */
  dirtyFiles: number
  builtAt: number | null
  /** Files re-indexed during the last incremental rebuild. */
  rebuiltFiles?: number
  /** Files purged during the last incremental rebuild. */
  rebuiltDeleted?: number
}

export type NotReady = {
  status: 'building' | 'unavailable'
  message: string
  progress: { parsed: number; total: number; phase: string } | null
}

export type Acquired =
  | { status: 'ready'; db: GraphDb; freshness: Freshness }
  | { status: 'not-ready'; notReady: NotReady }

/** FIFO mutex: one async critical section at a time. */
class AsyncMutex {
  private locked = false
  private readonly waiters: Array<() => void> = []

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true
        resolve()
      } else {
        this.waiters.push(resolve)
      }
    })
    try {
      return await fn()
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.locked = false
    }
  }
}

interface RepoEntry {
  repoRoot: string
  db?: GraphDb
  building?: Promise<void> | undefined
  progress: { parsed: number; total: number; phase: string }
  dirty: Set<string>
  /** Aborts this repo's background build; fired only from `dispose()`. */
  buildAbort?: AbortController
  error?: string
  mutex: AsyncMutex
}

export interface ManagerOptions {
  resolveDbPath(repoRoot: string): string
  open(dbPath: string, repoRoot: string): GraphDb
  /**
   * The limits in force right now. Read per build rather than captured once, so
   * a settings change that arrives between two builds is honoured by the second
   * without the manager holding a copy that could drift.
   */
  limits?(): IndexLimits
}

/** Minimal shape this manager needs from a tool execution context. */
interface ExecLike {
  agent?: { session?: { header?: { cwd?: string } } } | undefined
}

/** Owns one graph database per repository root. */
export class IndexManager {
  private readonly repos = new Map<string, RepoEntry>()
  private readonly options: ManagerOptions
  /** Paths marked dirty before their repository was known. */
  private readonly pendingDirty = new Set<string>()
  /** Set by `dispose()`; a build still in flight closes its own database. */
  private disposed = false

  constructor(options: ManagerOptions) {
    this.options = options
  }

  /** The index-shaping limits to build with. */
  private limits(): IndexLimits {
    return this.options.limits?.() ?? DEFAULT_INDEX_LIMITS
  }

  /**
   * Drop every open index without ending the manager's life.
   *
   * Called when a settings change alters what belongs in an index: rather than
   * reconciling a database against limits it was not built under, the manager
   * forgets it and the next call rebuilds from scratch. An in-flight build is
   * aborted for the same reason — it is producing an index nobody wants.
   * Unlike {@link dispose}, the manager stays usable afterwards.
   */
  reset(): void {
    for (const entry of this.repos.values()) {
      try {
        entry.buildAbort?.abort()
      } catch {
        // A reset must not throw: it runs from a settings watcher.
      }
      try {
        entry.db?.close()
      } catch {
        // Ignore close failures; the entry is being forgotten either way.
      }
    }
    this.repos.clear()
  }

  /**
   * Record that a file changed, so the next query re-indexes it.
   * Called from a synchronous event listener: it must stay allocation-cheap
   * and must never throw. Covers create, modify, and delete.
   * @param absolutePath - absolute path of the observed file.
   */
  markDirty(absolutePath: string): void {
    const abs = canonicalizePath(absolutePath)
    let matched = false
    for (const entry of this.repos.values()) {
      if (abs.startsWith(`${entry.repoRoot}/`)) {
        entry.dirty.add(abs.slice(entry.repoRoot.length + 1))
        matched = true
      }
    }
    if (!matched) this.pendingDirty.add(abs)
  }

  /**
   * Get a ready graph for the caller's workspace, starting a build if needed.
   * @param exec - the tool execution supplying the session working directory.
   * @param opts - cancellation for the freshness pass.
   * @returns A ready database handle, or a not-ready explanation.
   */
  async acquire(exec: ExecLike, opts: { signal?: AbortSignal } = {}): Promise<Acquired> {
    throwIfAborted(opts.signal)
    const repoRoot = canonicalizeRepoRoot(exec.agent?.session?.header?.cwd ?? process.cwd())
    let entry = this.repos.get(repoRoot)
    if (!entry) {
      entry = {
        repoRoot,
        progress: { parsed: 0, total: 0, phase: 'scanning' },
        dirty: new Set(),
        mutex: new AsyncMutex(),
      }
      this.repos.set(repoRoot, entry)
      // Safe to delete while iterating: a Set iterator never revisits an entry.
      for (const p of this.pendingDirty) {
        if (p.startsWith(`${repoRoot}/`)) {
          entry.dirty.add(p.slice(repoRoot.length + 1))
          this.pendingDirty.delete(p)
        }
      }
    }

    return entry.mutex.runExclusive(() => this.acquireLocked(entry, opts))
  }

  private async acquireLocked(entry: RepoEntry, opts: { signal?: AbortSignal }): Promise<Acquired> {
    throwIfAborted(opts.signal)
    // A previous failure must not pin the index unavailable forever: retry
    // on the next tool call (transient git timeouts, one-shot IO errors).
    if (entry.error !== undefined) delete entry.error

    if (!entry.db && !entry.building) this.startBuild(entry)

    if (entry.building) {
      // Give a fast build a brief chance to finish so small repositories answer
      // on the first call instead of forcing the model to retry. Aborting here
      // abandons the wait only — the build keeps running for the next call.
      try {
        const settled = await Promise.race([
          entry.building.then(() => 'done' as const),
          sleep(1500, opts.signal),
        ])
        if (settled === 'timeout') {
          return {
            status: 'not-ready',
            notReady: {
              status: 'building',
              message:
                'The code index is still building for this workspace. Retry this call shortly; '
                + 'meanwhile the ordinary read/grep tools remain available.',
              progress: { ...entry.progress },
            },
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw error
      }
      throwIfAborted(opts.signal)
    }

    if (entry.error || !entry.db) {
      return {
        status: 'not-ready',
        notReady: {
          status: 'unavailable',
          message: `index unavailable: ${entry.error ?? 'build did not produce a database'}`,
          progress: null,
        },
      }
    }

    const freshness = await this.refreshAndRebuild(entry, opts.signal)
    return { status: 'ready', db: entry.db, freshness }
  }

  private startBuild(entry: RepoEntry): void {
    const dbPath = this.options.resolveDbPath(entry.repoRoot)
    const controller = new AbortController()
    const signal = controller.signal
    entry.buildAbort = controller
    entry.building = (async () => {
      const db = this.options.open(dbPath, entry.repoRoot)
      try {
        // A database that already carries a finished build is reused as-is; the
        // freshness pass reconciles whatever changed since.
        const built = db.getMeta('built_at')
        if (built === undefined) {
          await fullBuild(db, entry.repoRoot, (p) => {
            entry.progress = { parsed: p.parsed, total: p.total, phase: p.phase }
          }, signal, this.limits())
        }
        throwIfAborted(signal)
        // Nothing owns this database once the manager is gone: dispose() has
        // already walked `repos` and will never see it.
        if (this.disposed) {
          db.close()
          return
        }
        entry.db = db
        entry.dirty.clear()
        delete entry.error
      } catch (error) {
        try {
          db.close()
        } catch {
          // Ignore close failures; the original error is what matters.
        }
        throw error
      }
    })()
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          entry.error = error instanceof Error ? error.message : String(error)
        }
      })
      .finally(() => {
        entry.building = undefined
        delete entry.buildAbort
      })
  }

  /**
   * Detect staleness, trigger an incremental rebuild if needed, and return
   * a Freshness snapshot describing the current state.
   *
   * Staleness triggers:
   *   - git HEAD changed (local commit, fast-forward, rebase, checkout)
   *   - agent-reported dirty files (markDirty), including deletes
   *   - out-of-band working-tree changes (git status, consulted every query)
   *   - git unavailable: mtime/size scan inside incrementalBuild
   */
  private async refreshAndRebuild(entry: RepoEntry, signal?: AbortSignal): Promise<Freshness> {
    throwIfAborted(signal)
    const db = entry.db
    if (!db) {
      return { status: 'building', head: null, dirtyFiles: entry.dirty.size, builtAt: null }
    }

    const storedHead = db.getMeta('head_commit') ?? null
    const state = await gitState(entry.repoRoot, signal)
    const headChanged = state.head !== undefined && storedHead !== null && state.head !== storedHead
    const builtAtRaw = db.getMeta('built_at')
    const builtAt = builtAtRaw === undefined ? null : Number(builtAtRaw)

    const gitPaths = await gitDirtyPaths(entry.repoRoot, signal)
    const gitDirty = (gitPaths?.length ?? 0) > 0
    const gitUnavailable = gitPaths === undefined
    const dirtyCount = entry.dirty.size
    const isStale = headChanged || dirtyCount > 0 || gitDirty || gitUnavailable

    if (!isStale) {
      return {
        status: 'ready',
        head: state.head ?? storedHead,
        dirtyFiles: 0,
        builtAt,
      }
    }

    const delta = [...new Set([...entry.dirty, ...(gitPaths ?? [])])]

    let result: IncrementalResult
    try {
      entry.progress = { parsed: 0, total: delta.length, phase: 'parsing' }
      result = await incrementalBuild(db, entry.repoRoot, delta, (p) => {
        entry.progress = { parsed: p.parsed, total: p.total, phase: p.phase }
      }, signal, this.limits())
    } catch (error) {
      if (isAbortError(error)) throw error
      entry.error = error instanceof Error ? error.message : String(error)
      return {
        status: 'stale',
        head: state.head ?? storedHead,
        dirtyFiles: entry.dirty.size,
        builtAt,
      }
    }

    entry.dirty.clear()

    if (result.filesIndexed === 0 && result.filesDeleted === 0) {
      return {
        status: 'ready',
        head: state.head ?? storedHead,
        dirtyFiles: 0,
        builtAt: Number(db.getMeta('built_at') ?? builtAt ?? Date.now()),
      }
    }

    return {
      status: 'ready',
      head: state.head ?? storedHead,
      dirtyFiles: 0,
      builtAt: Number(db.getMeta('built_at') ?? Date.now()),
      rebuiltFiles: result.filesIndexed,
      rebuiltDeleted: result.filesDeleted,
    }
  }

  /** Abort in-flight builds, close every database, and drop cached state. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.repos.values()) {
      try {
        entry.buildAbort?.abort()
      } catch {
        // Teardown must not throw.
      }
      try {
        entry.db?.close()
      } catch {
        // Teardown must not throw.
      }
    }
    this.repos.clear()
    this.pendingDirty.clear()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    timer.unref?.()
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(abortReason(signal))
      return
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }, { once: true })
  })
}
