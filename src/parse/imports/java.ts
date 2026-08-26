/**
 * Java type index, specifier resolution and import expansion.
 *
 * Java has no relative imports: an FQCN names a type, not a file. It resolves
 * through a package+filename index built from the file universe, on the
 * convention that a public top-level type's name matches its filename.
 */
import type { ImportRow } from '../../db.ts'
import { byName, createImportBinder } from './binder.ts'
import { readSource } from './caches.ts'

/** Package name -> FQCNs declared by `.java` files in this repository. */
export interface JavaTypeIndex {
  /** Fully-qualified type name -> repo-relative source path. */
  types: Map<string, string>
  /** Package name (empty string = default package) -> FQCNs in that package. */
  packages: Map<string, string[]>
}

const JAVA_PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/m

/**
 * Map Java types to files from package declarations + filenames.
 * Public top-level type names match the filename by convention; nested types
 * are not importable this way and fall through to low-confidence resolution.
 */
export function loadJavaTypes(repoRoot: string, files: string[]): JavaTypeIndex {
  const types = new Map<string, string>()
  const packages = new Map<string, string[]>()
  for (const rel of files) {
    if (!rel.endsWith('.java')) continue
    const base = rel.split('/').pop()?.replace(/\.java$/, '')
    if (!base) continue
    let pkg = ''
    try {
      const text = readSource(repoRoot, rel)
      pkg = text.match(JAVA_PACKAGE_RE)?.[1] ?? ''
    } catch {
      continue
    }
    const fqcn = pkg ? `${pkg}.${base}` : base
    types.set(fqcn, rel)
    const list = packages.get(pkg) ?? []
    list.push(fqcn)
    packages.set(pkg, list)
  }
  return { types, packages }
}

function simpleName(fqcn: string): string {
  return fqcn.split('.').pop() ?? fqcn
}

function packageOf(fqcn: string): string {
  const cut = fqcn.lastIndexOf('.')
  return cut < 0 ? '' : fqcn.slice(0, cut)
}

/**
 * Resolve an `import` FQCN to the file declaring it.
 *
 * The second lookup covers a static import, whose last segment names a member
 * rather than the type.
 * @returns Repo-relative target path, or undefined.
 */
export function resolveJavaSpecifier(spec: string, java: JavaTypeIndex): string | undefined {
  const direct = java.types.get(spec)
  if (direct) return direct
  const cut = spec.lastIndexOf('.')
  if (cut > 0) return java.types.get(spec.slice(0, cut))
  return undefined
}

/**
 * Expand Java wildcard / same-package / static-star imports into named bindings
 * so the language-agnostic call resolver can treat them like TS named imports.
 */
export function expandJavaImports(
  path: string,
  existing: readonly ImportRow[],
  java: JavaTypeIndex,
): ImportRow[] {
  // Java scopes simple names per compilation unit, so the key is the name alone.
  const binder = createImportBinder(path, byName)
  binder.seed(existing)

  const bindType = (fqcn: string, line: number): void => {
    const target = java.types.get(fqcn)
    if (target) binder.bindNamed(simpleName(fqcn), target, fqcn, line)
  }

  for (const imp of existing) {
    if (imp.kind === 'wildcard') {
      const pkg = imp.spec.replace(/\.\*$/, '')
      for (const fqcn of java.packages.get(pkg) ?? []) bindType(fqcn, imp.line)
    }
    if (imp.kind === 'static-star') {
      // Deliberately outside the dedup guard: the type's own name stays free
      // for a later same-package binding, as it is in javac.
      const typeFqcn = imp.spec.replace(/\.\*$/, '')
      const target = java.types.get(typeFqcn)
      if (target && target !== path) {
        binder.push({
          path,
          spec: typeFqcn,
          resolvedPath: target,
          line: imp.line,
          kind: 'namespace',
          name: simpleName(typeFqcn),
          imported: '*',
        })
      }
    }
  }

  let selfPkg: string | undefined
  for (const [fqcn, rel] of java.types) {
    if (rel === path) {
      selfPkg = packageOf(fqcn)
      break
    }
  }
  if (selfPkg !== undefined) {
    for (const fqcn of java.packages.get(selfPkg) ?? []) bindType(fqcn, 0)
  }

  return binder.rows
}
