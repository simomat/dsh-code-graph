/**
 * Rust crate/module index, specifier resolution and import expansion.
 *
 * A `use` path walks the module tree rather than the filesystem, so the index
 * reconstructs that tree from `Cargo.toml` (crate roots) and `mod` declarations
 * (parent -> child files); `resolveRustSpecifier` then walks it segment by
 * segment.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportRow } from '../../db.ts'
import { createImportBinder } from './binder.ts'
import { readSource } from './caches.ts'
import { posixDir, stripLineAndBlockComments } from './scan.ts'

/** Crate / module index built from Cargo.toml + `mod` declarations. */
export interface RustCrateIndex {
  /** file -> crate root file (`src/lib.rs` / `src/main.rs` / the file itself for tests/) */
  crateRoot: Map<string, string>
  /** crate package name -> lib crate root */
  packages: Map<string, string>
  /** `${crateRoot}\0${typeName}` -> declaring files */
  types: Map<string, string[]>
  /** file -> exported top-level names */
  exports: Map<string, string[]>
  /** file -> child module name -> child file */
  children: Map<string, Map<string, string>>
  /** child module file -> parent module file */
  parent: Map<string, string>
  /** crate root -> files in that crate (excluding integration tests) */
  crateFiles: Map<string, string[]>
}

/** File that declares `typeName` in the same Rust crate as `fromPath`. */
export function rustTypeFile(
  rust: RustCrateIndex,
  fromPath: string,
  typeName: string,
): string | undefined {
  const root = rust.crateRoot.get(fromPath)
  if (!root) return undefined
  const files = rust.types.get(`${root}\0${typeName}`)
  if (!files || files.length === 0) return undefined
  if (files.includes(fromPath)) return fromPath
  return files[0]
}

function rustModName(file: string): string {
  const base = file.split('/').pop() ?? file
  if (base === 'mod.rs') {
    const parts = posixDir(file).split('/')
    return parts[parts.length - 1] ?? 'mod'
  }
  return base.replace(/\.rs$/, '')
}

function rustChildDir(file: string): string {
  const base = file.split('/').pop() ?? file
  const dir = posixDir(file)
  if (base === 'lib.rs' || base === 'main.rs' || base === 'mod.rs') return dir
  return file.replace(/\.rs$/, '')
}

function rustTypeNames(text: string): string[] {
  const names: string[] = []
  const stripped = stripLineAndBlockComments(text)
  for (const m of stripped.matchAll(
    /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+([A-Za-z_][\w]*)/g,
  )) {
    if (m[1]) names.push(m[1])
  }
  return [...new Set(names)]
}

function rustExportedNames(text: string): string[] {
  const names = new Set<string>()
  const stripped = stripLineAndBlockComments(text)
  for (const m of stripped.matchAll(
    /^(?:pub(?:\([^)]*\))?\s+)(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_][\w]*)/gm,
  )) {
    if (m[1]) names.add(m[1])
  }
  for (const m of stripped.matchAll(
    /^(?:pub(?:\([^)]*\))?\s+)(?:struct|enum|trait|union|type)\s+([A-Za-z_][\w]*)/gm,
  )) {
    if (m[1]) names.add(m[1])
  }
  return [...names]
}

function rustModDecls(text: string): string[] {
  const names: string[] = []
  const stripped = stripLineAndBlockComments(text)
  for (const m of stripped.matchAll(
    /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][\w]*)\s*;/g,
  )) {
    if (m[1]) names.push(m[1])
  }
  return names
}

function tomlSection(text: string, header: string): string | undefined {
  const m = text.match(new RegExp(`\\[${header}\\]([^\\[]*)`))
  return m?.[1]
}

function tomlQuoted(section: string, key: string): string | undefined {
  return section.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
}

export function loadRustCrates(repoRoot: string, files: string[]): RustCrateIndex {
  const crateRoot = new Map<string, string>()
  const packages = new Map<string, string>()
  const types = new Map<string, string[]>()
  const exports = new Map<string, string[]>()
  const children = new Map<string, Map<string, string>>()
  const parent = new Map<string, string>()
  const crateFiles = new Map<string, string[]>()

  const rsFiles = files.filter((f) => f.endsWith('.rs') && !/(^|\/)target\//.test(f))
  const fileSet = new Set(rsFiles)

  const crates: Array<{ dir: string; name: string; lib?: string | undefined; main?: string | undefined }> = []
  for (const rel of files) {
    if (!rel.endsWith('Cargo.toml') || /(^|\/)target\//.test(rel)) continue
    let text: string
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    const pkg = tomlSection(text, 'package')
    const name = pkg ? tomlQuoted(pkg, 'name') : undefined
    if (!name) continue
    const dir = posixDir(rel)
    const libSection = tomlSection(text, 'lib')
    const libOverride = libSection ? tomlQuoted(libSection, 'path') : undefined
    const libCand = libOverride
      ? (dir ? `${dir}/${libOverride}` : libOverride)
      : (dir ? `${dir}/src/lib.rs` : 'src/lib.rs')
    const mainCand = dir ? `${dir}/src/main.rs` : 'src/main.rs'
    crates.push({
      dir,
      name,
      lib: fileSet.has(libCand) ? libCand : undefined,
      main: fileSet.has(mainCand) ? mainCand : undefined,
    })
  }
  crates.sort((a, b) => b.dir.length - a.dir.length)

  const crateDirFor = (file: string): typeof crates[number] | undefined => {
    return crates.find((c) =>
      c.dir === '' || file === c.dir || file.startsWith(`${c.dir}/`),
    )
  }

  for (const crate of crates) {
    const root = crate.lib ?? crate.main
    if (root) packages.set(crate.name, root)
  }

  for (const rel of rsFiles) {
    const crate = crateDirFor(rel)
    const prefix = crate?.dir ? `${crate.dir}/` : ''
    const integration = rel.startsWith(`${prefix}tests/`)
    const root = integration ? rel : (crate?.lib ?? crate?.main ?? rel)
    crateRoot.set(rel, root)
    if (!integration) {
      const list = crateFiles.get(root) ?? []
      list.push(rel)
      crateFiles.set(root, list)
    }
    let text: string
    try {
      text = readSource(repoRoot, rel)
    } catch {
      continue
    }
    const exported = rustExportedNames(text)
    if (exported.length > 0) exports.set(rel, exported)
    for (const typeName of rustTypeNames(text)) {
      const key = `${root}\0${typeName}`
      const list = types.get(key) ?? []
      list.push(rel)
      types.set(key, list)
    }
  }

  for (const rel of rsFiles) {
    if (crateRoot.get(rel) === rel && rel.split('/').includes('tests')) continue
    let text: string
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    const dir = rustChildDir(rel)
    const map = children.get(rel) ?? new Map<string, string>()
    for (const name of rustModDecls(text)) {
      const a = dir ? `${dir}/${name}.rs` : `${name}.rs`
      const b = dir ? `${dir}/${name}/mod.rs` : `${name}/mod.rs`
      const child = fileSet.has(a) ? a : fileSet.has(b) ? b : undefined
      if (!child) continue
      map.set(name, child)
      parent.set(child, rel)
    }
    if (map.size > 0) children.set(rel, map)
  }

  return { crateRoot, packages, types, exports, children, parent, crateFiles }
}

function rustModuleSpec(file: string, rust: RustCrateIndex): string | undefined {
  const root = rust.crateRoot.get(file)
  if (!root || file === root) return undefined
  const parts: string[] = []
  let cur: string | undefined = file
  const seen = new Set<string>()
  while (cur && cur !== root && !seen.has(cur)) {
    seen.add(cur)
    parts.unshift(rustModName(cur))
    cur = rust.parent.get(cur)
  }
  return parts.length > 0 ? `crate::${parts.join('::')}` : undefined
}

/**
 * Resolve a `use` path by walking the module tree from its anchor.
 * @param spec - the raw path, `::*` and trailing `*` tolerated.
 * @param fromPath - repo-relative path of the importing file.
 * @returns Repo-relative target path, or undefined.
 */
export function resolveRustSpecifier(
  spec: string,
  fromPath: string,
  rust: RustCrateIndex,
): string | undefined {
  const raw = spec.replace(/::\*$/, '').replace(/\*$/, '')
  const parts = raw.split('::').filter((p) => p.length > 0)
  if (parts.length === 0) return undefined
  const root = rust.crateRoot.get(fromPath)

  let current: string | undefined
  let i = 0
  const first = parts[0]
  if (first === 'crate') {
    current = root
    i = 1
  } else if (first === 'super') {
    current = rust.parent.get(fromPath)
    i = 1
    while (i < parts.length && parts[i] === 'super') {
      current = current ? rust.parent.get(current) : undefined
      i += 1
    }
  } else if (first === 'self') {
    current = fromPath
    i = 1
  } else if (first && rust.packages.has(first) && rust.packages.get(first) !== root) {
    current = rust.packages.get(first)
    i = 1
  } else {
    current = fromPath
  }
  if (!current) return undefined

  let cursor = current
  for (; i < parts.length; i += 1) {
    const seg = parts[i]
    if (!seg) continue
    const child: string | undefined = rust.children.get(cursor)?.get(seg)
    if (child) {
      cursor = child
      continue
    }
    if (i === parts.length - 1) return cursor
    return undefined
  }
  return cursor
}

/**
 * Expand Rust `use` paths into namespace / named bindings, plus `crate::mod`
 * namespaces so fully-qualified calls resolve without a `use`.
 */
export function expandRustImports(
  path: string,
  existing: readonly ImportRow[],
  rust: RustCrateIndex,
): ImportRow[] {
  const binder = createImportBinder(path)
  binder.seed(existing)

  for (const imp of existing) {
    const target = imp.resolvedPath
    if (!target) continue
    if (imp.kind === 'wildcard') {
      for (const name of rust.exports.get(target) ?? []) {
        binder.bindNamed(name, target, imp.spec, imp.line)
      }
      continue
    }
    const last = imp.name
    if (!last || last === '*') continue
    // `use foo::bar` binds a module or an item; only the former is a namespace.
    const isMod = rustModName(target) === last || rustModName(target) === (imp.imported ?? '')
    if (isMod) binder.bindNamespace(last, target, imp.spec, imp.line)
    else binder.bindNamed(last, target, imp.spec, imp.line, imp.imported ?? last)
  }

  const root = rust.crateRoot.get(path)
  if (root && root !== path) {
    for (const file of rust.crateFiles.get(root) ?? []) {
      const spec = rustModuleSpec(file, rust)
      if (spec) binder.bindNamespace(spec, file, spec, 0)
    }
  }

  return binder.rows
}
