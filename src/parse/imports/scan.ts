/**
 * Two helpers the Go and Rust index passes both need.
 *
 * Neither is language-specific: Go and Rust share C comment syntax, and both
 * index passes work in repo-relative POSIX paths regardless of host platform.
 */

/**
 * Drop `//` line and block comments.
 *
 * Both index passes only ever regex-scan the result for declarations, so one
 * pass serves both. Not string-aware — a `//` inside a literal is stripped too,
 * which costs at worst a missed declaration on a line that also holds a
 * slash-slash string.
 */
export function stripLineAndBlockComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Directory part of a repo-relative path, `''` at the root. */
export function posixDir(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? '' : rel.slice(0, cut)
}
