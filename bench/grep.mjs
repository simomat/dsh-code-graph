/**
 * The read/grep/glob loop this plugin claims to replace, simulated.
 *
 * Pure JS rather than a shell out to `rg`: an external binary would put its
 * version and its default ignore rules into every number, and neither is pinned
 * by anything this repository controls.
 *
 * The ranking is deliberately crude, because the thing being modelled is crude:
 * count case-insensitive occurrences of each search term across the indexed
 * files, rank by total matches, and read the top few in full. An agent that
 * greps and then reads does roughly this, and it pays for the whole file.
 *
 * Ties break on path, ascending. That is not cosmetic — without it the baseline
 * would depend on filesystem enumeration order and two runs on the same tree
 * could disagree.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIN_TERM_LENGTH, STOPWORDS } from './config.mjs'

/**
 * Derive search terms from a question.
 *
 * Lowercase, split on non-word characters, drop the committed stopword list,
 * drop anything shorter than `MIN_TERM_LENGTH`, and de-duplicate while keeping
 * first-seen order. A question may override this with an explicit `terms` array
 * where the derivation would produce something silly; the override is data in
 * `bench/config.mjs`, so it stays as reproducible as the derivation.
 * @param question - the question text.
 * @returns Search terms, in first-seen order.
 */
export function deriveTerms(question) {
  const seen = new Set()
  for (const raw of question.toLowerCase().split(/[^\w]+/)) {
    if (raw.length < MIN_TERM_LENGTH) continue
    if (STOPWORDS.has(raw)) continue
    seen.add(raw)
  }
  return [...seen]
}

/**
 * Count case-insensitive occurrences of a term in text.
 *
 * Overlapping matches are not a concern for identifier-shaped terms, and a
 * plain `indexOf` walk avoids building a regex per term per file.
 * @param haystack - already lowercased text.
 * @param needle - an already lowercased term.
 * @returns The number of occurrences.
 */
export function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Rank files by how often the terms appear in them.
 *
 * Files with no match at all are dropped rather than ranked last: an agent's
 * grep would never surface them, so reading them is not part of the baseline.
 * @param files - `{ path }` records, from the index.
 * @param terms - lowercased search terms.
 * @param options - where the files live and how to read them.
 * @param options.repoDir - the repository root the paths are relative to.
 * @param options.read - file reader, injectable for tests.
 * @returns Matching files, best first, ties broken on path ascending.
 */
export function rankFiles(files, terms, { repoDir, read = defaultRead }) {
  const scored = []
  for (const file of files) {
    let text
    try {
      text = read(join(repoDir, file.path)).toLowerCase()
    } catch {
      // A file in the index that cannot be read now (a symlink, a permission)
      // is not a match and not an error worth failing a run over.
      continue
    }
    let matches = 0
    for (const term of terms) matches += countOccurrences(text, term)
    if (matches > 0) scored.push({ path: file.path, matches })
  }
  scored.sort((a, b) => b.matches - a.matches || a.path.localeCompare(b.path))
  return scored
}

/**
 * Read a file as UTF-8.
 * @param path - absolute path.
 * @returns The file's text.
 */
function defaultRead(path) {
  return readFileSync(path, 'utf8')
}

/**
 * What a grep-then-read agent would pay for one question.
 * @param files - `{ path }` records, from the index.
 * @param terms - lowercased search terms.
 * @param options - reading and sizing controls.
 * @param options.repoDir - the repository root the paths are relative to.
 * @param options.topN - how many files the agent reads (default 3).
 * @param options.read - file reader, injectable for tests.
 * @returns `{ read: [{path, matches, chars, text}], candidates }`.
 */
export function grepAndRead(files, terms, { repoDir, topN = 3, read = defaultRead }) {
  const ranked = rankFiles(files, terms, { repoDir, read })
  // The text comes back with the hit: the caller has to count tokens over it,
  // and for a real tokenizer the character count is not enough to do that.
  const chosen = ranked.slice(0, topN).map((hit) => {
    const text = read(join(repoDir, hit.path))
    return { ...hit, chars: text.length, text }
  })
  return { read: chosen, candidates: ranked.length }
}
