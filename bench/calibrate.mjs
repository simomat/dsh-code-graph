/**
 * Justifying the `chars / 4` shortcut, or failing to.
 *
 * Every default row this harness writes is an estimate. That is only defensible
 * if the estimate has been checked against a real tokenizer over real source, so
 * this mode does that and the result is committed to `bench/README.md`.
 *
 * The sample is deterministic and spread: every *n*-th file by sorted path,
 * rather than the first *n*. Taking the first *n* would sample one directory of
 * one language and call the answer a calibration.
 *
 * What it does **not** establish: this plugin targets DeepSeek Harness models,
 * and `cl100k_base` is OpenAI's. A close ratio here says `chars / 4` is a sane
 * shortcut for source code, not that the token counts are what a DeepSeek model
 * would bill. Indicative, not model-accurate — and the docs say so too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { indexedFiles } from './graph.mjs'
import { markdownTable } from './report.mjs'
import { ratioOf } from './tokens.mjs'

/** Files sampled per repository. */
export const SAMPLE_SIZE = 50

/**
 * Take an evenly spread, deterministic sample.
 * @param files - the indexed files, already ordered by path.
 * @param size - how many to take.
 * @returns The sampled files.
 */
export function sample(files, size = SAMPLE_SIZE) {
  if (files.length <= size) return files
  const stride = files.length / size
  return Array.from({ length: size }, (_, i) => files[Math.floor(i * stride)])
}

/**
 * Calibrate one repository.
 * @param db - the open graph.
 * @param repo - the prepared repository.
 * @param counter - a verifying counter.
 * @returns A calibration row.
 */
export function calibrateRepo(db, repo, counter) {
  let chars = 0
  let estimated = 0
  let real = 0
  let files = 0
  for (const file of sample(indexedFiles(db))) {
    let text
    try {
      text = readFileSync(join(repo.dir, file.path), 'utf8')
    } catch {
      continue
    }
    const counted = counter.count(text)
    chars += text.length
    estimated += counted.estimated
    real += counted.real
    files += 1
  }
  return { repo: repo.name, lang: repo.lang, files, chars, estimated, real, ratio: ratioOf(estimated, real) }
}

/**
 * Render the calibration table.
 * @param rows - per-repository calibration rows.
 * @returns `{ table, overall }`.
 */
export function renderCalibration(rows) {
  const overall = rows.reduce(
    (acc, r) => ({
      files: acc.files + r.files,
      chars: acc.chars + r.chars,
      estimated: acc.estimated + r.estimated,
      real: acc.real + r.real,
    }),
    { files: 0, chars: 0, estimated: 0, real: 0 },
  )
  overall.ratio = ratioOf(overall.estimated, overall.real)

  const fmt = (n) => n.toLocaleString('en-US')
  const table = markdownTable(
    ['Repo', 'Language', 'Files', 'Chars', 'chars/4 estimate', 'cl100k real', 'Ratio'],
    [
      ...rows.map((r) => [r.repo, r.lang, r.files, fmt(r.chars), fmt(r.estimated), fmt(r.real), r.ratio]),
      ['**overall**', '—', overall.files, fmt(overall.chars), fmt(overall.estimated), fmt(overall.real), `**${overall.ratio}**`],
    ],
  )
  return { table, overall }
}
