/**
 * Qualified-name uniqueness.
 *
 * A qname is `path::Type.member` — it carries no arity and no parameter types,
 * so two declarations in one file can legitimately produce the same string:
 * Java/Go/Rust method overloads (`render(String)` / `render(int)`), TypeScript
 * declaration merging (`interface Foo` twice), a re-declared `var`.
 *
 * `qname` is the primary key of `nodes`, so a collision used to upsert the
 * later declaration on top of the earlier one and delete it from the graph
 * outright. Discriminating instead keeps every declaration addressable.
 */

/**
 * Return `qname` if unused, otherwise a `#n` discriminated variant, recording
 * the result in `taken`.
 *
 * The first declaration keeps the bare qname on purpose: call resolution
 * synthesizes targets as `${classQname}.${methodName}` and must land on a real
 * node. Later declarations become `…#2`, `…#3`, each with its own signature and
 * line range, so nothing silently disappears.
 * @param qname - the qualified name the extractor derived.
 * @param taken - qnames already emitted for this file, extended in place.
 * @returns A qname unique within `taken`.
 */
export function distinctQname(qname: string, taken: Set<string>): string {
  if (!taken.has(qname)) {
    taken.add(qname)
    return qname
  }
  let n = 2
  while (taken.has(`${qname}#${n}`)) n += 1
  const distinct = `${qname}#${n}`
  taken.add(distinct)
  return distinct
}
