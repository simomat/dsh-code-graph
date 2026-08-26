/**
 * Go package index, specifier resolution and import expansion.
 *
 * A Go import names a package directory, not a file, so the index maps import
 * paths (derived from the enclosing `go.mod`) to the files that make up each
 * package, plus the exported names those files declare.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportRow } from '../../db.ts'
import { createImportBinder } from './binder.ts'
import { readSource } from './caches.ts'
import { posixDir, stripLineAndBlockComments } from './scan.ts'

/** Package directory index built from `go.mod` + `.go` files in this repository. */
export interface GoPackageIndex {
  /** Import path -> production package files (excludes `package foo_test`). */
  packages: Map<string, string[]>
  /** Import path -> package identifier (`util`, not the last path segment). */
  packageName: Map<string, string>
  files: Map<string, { importPath: string; packageName: string }>
  /** `${importPath}\0${packageName}\0${typeName}` -> declaring file */
  types: Map<string, string>
  /** file -> exported top-level names (types + functions, not methods). */
  exports: Map<string, string[]>
  /** `${dir}\0${packageName}` -> files sharing that package. */
  siblings: Map<string, string[]>
}

/** File that declares `typeName` in the same Go package as `fromPath`. */
export function goTypeFile(
  go: GoPackageIndex,
  fromPath: string,
  typeName: string,
): string | undefined {
  const meta = go.files.get(fromPath)
  if (!meta) return undefined
  return go.types.get(`${meta.importPath}\0${meta.packageName}\0${typeName}`)
}

function parseGoModule(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/\/\/.*$/, '').trim()
    const m = /^module\s+(\S+)/.exec(trimmed)
    if (m?.[1]) return m[1]
  }
  return undefined
}

/** Top-level type names, over text whose comments are already stripped. */
function goTypeNamesFrom(stripped: string): string[] {
  const names: string[] = []
  for (const m of stripped.matchAll(/(?:^|\n)\s*type\s+(\w+)\b/g)) {
    if (m[1]) names.push(m[1])
  }
  let inGroup = false
  let depth = 0
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim()
    if (!inGroup) {
      if (/^type\s*\(/.test(trimmed)) {
        inGroup = true
        depth = 1
        depth += (line.match(/\(/g)?.length ?? 0) - 1 - (line.match(/\)/g)?.length ?? 0)
        const same = /^type\s*\(\s*(\w+)/.exec(trimmed)
        if (same?.[1]) names.push(same[1])
        if (depth <= 0) inGroup = false
      }
      continue
    }
    const startDepth = depth
    if (startDepth === 1) {
      const ident = /^([A-Za-z_]\w*)\b/.exec(trimmed)
      if (ident?.[1]) names.push(ident[1])
    }
    depth += (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0)
    if (depth <= 0) inGroup = false
  }
  return [...new Set(names)]
}

/** Exported top-level names, over text whose comments are already stripped. */
function goExportedNamesFrom(stripped: string): string[] {
  const names = new Set<string>()
  for (const m of stripped.matchAll(/(?:^|\n)\s*func\s+([A-Z]\w*)\s*(?:\(|\[)/g)) {
    if (m[1]) names.add(m[1])
  }
  for (const name of goTypeNamesFrom(stripped)) {
    const first = name[0]
    if (first && first !== first.toLowerCase()) names.add(name)
  }
  return [...names]
}

export function loadGoPackages(repoRoot: string, files: string[]): GoPackageIndex {
  const packages = new Map<string, string[]>()
  const packageName = new Map<string, string>()
  const fileMeta = new Map<string, { importPath: string; packageName: string }>()
  const types = new Map<string, string>()
  const exports = new Map<string, string[]>()
  const siblings = new Map<string, string[]>()

  const modules: Array<{ dir: string; path: string }> = []
  const seenMods = new Set<string>()
  const considerMod = (rel: string): void => {
    if (seenMods.has(rel) || !rel.endsWith('go.mod')) return
    seenMods.add(rel)
    try {
      const text = readFileSync(join(repoRoot, rel), 'utf8')
      const mod = parseGoModule(text)
      if (!mod) return
      const dir = posixDir(rel)
      modules.push({ dir, path: mod })
    } catch {
      // ignore unreadable go.mod
    }
  }
  considerMod('go.mod')
  for (const rel of files) considerMod(rel)
  modules.sort((a, b) => b.dir.length - a.dir.length)

  const importPathFor = (fileDir: string): string => {
    const mod = modules.find((m) =>
      m.dir === fileDir || (m.dir !== '' && (fileDir === m.dir || fileDir.startsWith(`${m.dir}/`)))
      || m.dir === '',
    )
    if (!mod) return fileDir || '.'
    if (mod.dir === '') return fileDir ? `${mod.path}/${fileDir}` : mod.path
    const rest = fileDir === mod.dir ? '' : fileDir.slice(mod.dir.length + 1)
    return rest ? `${mod.path}/${rest}` : mod.path
  }

  for (const rel of files) {
    if (!rel.endsWith('.go') || /(^|\/)(vendor|testdata)\//.test(rel)) continue
    let text: string
    try {
      text = readSource(repoRoot, rel)
    } catch {
      continue
    }
    const pkg = text.match(/^package\s+(\w+)/m)?.[1]
    if (!pkg) continue
    const dir = posixDir(rel)
    const importPath = importPathFor(dir)
    fileMeta.set(rel, { importPath, packageName: pkg })
    const sibKey = `${dir}\0${pkg}`
    const sibs = siblings.get(sibKey) ?? []
    sibs.push(rel)
    siblings.set(sibKey, sibs)
    if (!pkg.endsWith('_test')) {
      const list = packages.get(importPath) ?? []
      list.push(rel)
      packages.set(importPath, list)
      if (!packageName.has(importPath)) packageName.set(importPath, pkg)
    }
    // One strip serves both scans; each of these used to redo it internally.
    const stripped = stripLineAndBlockComments(text)
    const exported = goExportedNamesFrom(stripped)
    if (exported.length > 0) exports.set(rel, exported)
    for (const typeName of goTypeNamesFrom(stripped)) {
      types.set(`${importPath}\0${pkg}\0${typeName}`, rel)
    }
  }

  return { packages, packageName, files: fileMeta, types, exports, siblings }
}

/**
 * Resolve an import path to a file standing in for the package it names.
 * @returns The package's first production file, or undefined when the package
 * is external to this repository.
 */
export function resolveGoSpecifier(spec: string, go: GoPackageIndex): string | undefined {
  return go.packages.get(spec)?.[0]
}

/**
 * Expand Go package imports into per-file namespace / named bindings so the
 * language-agnostic call resolver can treat `util.Foo` like a TS namespace import.
 */
export function expandGoImports(
  path: string,
  existing: readonly ImportRow[],
  go: GoPackageIndex,
): ImportRow[] {
  const binder = createImportBinder(path)
  binder.seed(existing)

  for (const imp of existing) {
    const pkgFiles = go.packages.get(imp.spec)
    if (!pkgFiles || pkgFiles.length === 0) continue
    const pkgIdent = go.packageName.get(imp.spec) ?? posixDir(pkgFiles[0] ?? '').split('/').pop() ?? imp.spec
    if (imp.kind === 'side-effect') {
      for (const file of pkgFiles) binder.bindSideEffect('_', file, imp.spec, imp.line)
      continue
    }
    if (imp.kind === 'dot') {
      for (const file of pkgFiles) {
        for (const name of go.exports.get(file) ?? []) binder.bindNamed(name, file, imp.spec, imp.line)
      }
      continue
    }
    const local = imp.kind === 'alias' && imp.name ? imp.name : pkgIdent
    for (const file of pkgFiles) binder.bindNamespace(local, file, imp.spec, imp.line)
  }

  const meta = go.files.get(path)
  if (meta) {
    const sibs = go.siblings.get(`${posixDir(path)}\0${meta.packageName}`) ?? []
    for (const file of sibs) {
      if (file === path) continue
      for (const name of go.exports.get(file) ?? []) {
        binder.bindNamed(name, file, meta.importPath, 0)
      }
    }
  }

  return binder.rows
}
