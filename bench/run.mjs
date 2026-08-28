/**
 * The benchmark entry point.
 *
 * `pnpm run bench` runs everything; `--scenario` and `--repo` narrow it. One
 * invocation is one `run_id`: it prepares every repository at its pinned SHA,
 * builds a fresh index for each into a temp directory, runs every scenario at
 * every budget, writes one CSV per repo and scenario, and prints the tables.
 *
 * The order matters. Repositories are prepared and verified *before* any
 * measuring starts, so a bad pin aborts in seconds rather than after twenty
 * minutes of work that has to be thrown away.
 */
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUDGETS, REPOS, SCENARIOS } from './config.mjs'
import { buildIndex, benchConfig, createIndexDir, freshnessFor } from './graph.mjs'
import { checkNodeVersion, prepareRepo } from './repos.mjs'
import { calibrateRepo, renderCalibration } from './calibrate.mjs'
import { captureReferenceTools } from './reference.mjs'
import { createCounter } from './tokens.mjs'
import { writeCsv } from './csv.mjs'
import { printReport, writeManifest } from './output.mjs'

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(BENCH_DIR, '..')

/** Scenarios that run once per invocation rather than once per repository. */
const GLOBAL_SCENARIOS = new Set(['tool-schema-overhead'])

/**
 * Parse the command line.
 * @param argv - `process.argv.slice(2)`.
 * @returns Parsed options.
 */
export function parseArgs(argv) {
  const options = { scenarios: null, repos: null, verify: false, capture: false, calibrate: false, outDir: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[i += 1]
    // pnpm forwards the `--` separator from `pnpm run bench -- --scenario x`,
    // and that is the documented invocation, so it is not an error.
    if (arg === '--') continue
    if (arg === '--scenario') options.scenarios = (options.scenarios ?? []).concat(next().split(','))
    else if (arg === '--repo') options.repos = (options.repos ?? []).concat(next().split(','))
    else if (arg === '--verify') options.verify = true
    else if (arg === '--capture-reference') options.capture = true
    else if (arg === '--calibrate') options.calibrate = true
    else if (arg === '--out') options.outDir = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  for (const name of options.scenarios ?? []) {
    if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario: ${name}\nknown: ${SCENARIOS.join(', ')}`)
  }
  for (const name of options.repos ?? []) {
    if (!REPOS.some((r) => r.name === name)) {
      throw new Error(`unknown repo: ${name}\nknown: ${REPOS.map((r) => r.name).join(', ')}`)
    }
  }
  return options
}

/**
 * Load a scenario module by name.
 * @param name - the scenario name.
 * @returns Its module.
 */
async function loadScenario(name) {
  return import(`./scenarios/${name}.mjs`)
}

/**
 * Run the benchmark.
 * @param argv - command-line arguments.
 * @returns A process exit code.
 */
export async function main(argv) {
  const options = parseArgs(argv)

  if (options.capture) {
    const { path, tools } = await captureReferenceTools(BENCH_DIR)
    process.stdout.write(`captured ${tools.length} reference tools -> ${path}\n`)
    return 0
  }

  const node = await checkNodeVersion(REPO_ROOT)
  // Calibration is the comparison of the estimate against a real tokenizer, so
  // it cannot run without one.
  const counter = await createCounter({ verify: options.verify || options.calibrate })
  const config = benchConfig()
  const scenarios = options.scenarios ?? SCENARIOS
  const repos = REPOS.filter((r) => !options.repos || options.repos.includes(r.name))

  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const date = runId.slice(0, 10)
  const outDir = options.outDir ?? join(BENCH_DIR, 'results', date)

  // Verify every pin before measuring anything: a mismatch should cost seconds.
  process.stderr.write(`preparing ${repos.length} repositories\n`)
  const prepared = []
  for (const repo of repos) prepared.push(await prepareRepo(repo, { cacheDir: join(BENCH_DIR, '.repos'), repoRoot: REPO_ROOT }))

  const indexDir = await createIndexDir()
  const allRows = []
  const calibration = []

  try {
    for (const repo of prepared) {
      const perRepo = scenarios.filter((s) => !GLOBAL_SCENARIOS.has(s))
      if (perRepo.length === 0 && !options.calibrate) continue

      process.stderr.write(`building index for ${repo.name} (${repo.sha.slice(0, 8)})\n`)
      const built = await buildIndex(repo.dir, { indexDir, name: repo.name, config })
      const freshness = freshnessFor(repo.sha)
      const base = {
        run_id: runId,
        date,
        repo: repo.name,
        repo_sha: repo.sha,
        estimated: true,
        node_version: node.version,
      }

      try {
        if (options.calibrate) calibration.push(calibrateRepo(built.db, repo, counter))
        for (const name of perRepo) {
          const scenario = await loadScenario(name)
          const rows = []
          for (const budget of BUDGETS) {
            rows.push(...await scenario.run({
              db: built.db,
              repo,
              budget: budget.limit,
              counter,
              base,
              freshness,
              config,
              build: { result: built.build, dbBytes: built.dbBytes, elapsedMs: built.elapsedMs },
            }))
          }
          writeCsv(join(outDir, `${name}--${repo.name}.csv`), rows)
          allRows.push(...rows)
        }
      } finally {
        built.db.close()
      }
    }

    for (const name of scenarios.filter((s) => GLOBAL_SCENARIOS.has(s))) {
      const scenario = await loadScenario(name)
      const rows = await scenario.run({
        base: { run_id: runId, date, estimated: true, node_version: node.version },
        counter,
        benchDir: BENCH_DIR,
      })
      writeCsv(join(outDir, `${name}.csv`), rows)
      allRows.push(...rows)
    }
  } finally {
    // The index is never reused between runs, so it goes with the run.
    await rm(indexDir, { recursive: true, force: true })
  }

  const manifest = await writeManifest(outDir, { runId, date, node, prepared, options, counter, config })
  printReport(allRows, { outDir, manifest })

  if (calibration.length > 0) {
    const { table } = renderCalibration(calibration)
    process.stdout.write(`\n## chars/4 calibration against cl100k_base\n\n${table}\n\n`)
    process.stdout.write('> Sample: every n-th indexed file by sorted path, per repository. '
      + 'This plugin targets DeepSeek Harness models and `cl100k_base` is OpenAI\'s, so a close '
      + 'ratio says the shortcut is sane for source code — not that these counts are what a '
      + 'DeepSeek model would bill.\n\n')
  }
  return 0
}

process.exitCode = await main(process.argv.slice(2))
