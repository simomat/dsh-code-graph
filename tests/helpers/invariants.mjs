/**
 * Shared FTS invariant, asserted over every language fixture.
 *
 * `nodes_fts` is an external-content index over `nodes`: a hit is only honest
 * if the row it points at really contains the term. B2 broke exactly that —
 * an upsert that landed on DO UPDATE indexed a symbol's tokens against an
 * unrelated node's rowid — so this single property is the regression guard for
 * that whole class of bug.
 */
import assert from 'node:assert/strict'

/**
 * Assert every FTS hit is backed by a node whose indexed text contains the term.
 * @param db - an open GraphDb.
 * @param label - fixture name, for the failure message.
 */
export function assertFtsConsistent(db, label = 'graph') {
  const nodes = db.db.prepare('SELECT rowid, name, qname, signature FROM nodes').all()
  const byRowid = new Map(nodes.map((n) => [n.rowid, n]))
  const match = db.db.prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?')
  const terms = [...new Set(nodes.map((n) => n.name))].filter((n) => /^[A-Za-z_]\w*$/.test(n))

  const phantoms = []
  for (const term of terms) {
    for (const { rowid } of match.all(`"${term}"`)) {
      const row = byRowid.get(rowid)
      if (!row) {
        phantoms.push(`"${term}" -> rowid ${rowid} with no node`)
        continue
      }
      // Lowercased on both sides: FTS5's tokenizer case-folds, so `init`
      // legitimately answers a query for `Init`.
      const indexed = `${row.name} ${row.qname} ${row.signature ?? ''}`.toLowerCase()
      if (!indexed.includes(term.toLowerCase())) phantoms.push(`"${term}" -> ${row.qname}`)
    }
  }
  assert.deepEqual(phantoms, [], `${label}: fabricated FTS hits`)

  // Throws when the index disagrees with the content table.
  db.db.prepare(`INSERT INTO nodes_fts(nodes_fts) VALUES('integrity-check')`).run()
}
