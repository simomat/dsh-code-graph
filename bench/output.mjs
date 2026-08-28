/**
 * What a run prints, and the manifest that makes it checkable later.
 *
 * The printing rules are the honesty rules, in code:
 *
 * - every aggregate table carries a **Budget** column, because a ratio without
 *   the budget beside it is not interpretable;
 * - `corpus-baseline` is captioned as an upper bound wherever it appears;
 * - `tool-schema-overhead` gets its **own** table, because a per-session fixed
 *   cost added to a per-question ratio would describe no real workload;
 * - errors are counted out loud, and never folded into a number.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { BASELINE_LABELS, markdownTable, okRows, summarise } from './report.mjs'

/**
 * Write the run manifest.
 *
 * Everything needed to say what these numbers describe: the pinned commits, the
 * Node version, the budgets, the machine. A CSV without this is a table of
 * numbers nobody can reproduce.
 * @param outDir - the results directory.
 * @param run - the run's parameters.
 * @returns The manifest object.
 */
export async function writeManifest(outDir, { runId, date, node, prepared, options, counter, config }) {
  const manifest = {
    runId,
    date,
    node: { version: node.version, pinned: node.pinned, matchesPin: node.matchesPin },
    platform: `${process.platform} ${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    tokenizer: counter.verify ? 'gpt-tokenizer cl100k_base (plus chars/4 estimate)' : 'chars/4 estimate only',
    budgets: { defaultBudget: config.defaultBudget, maxBudget: config.maxBudget },
    filters: { scenarios: options.scenarios, repos: options.repos },
    repos: prepared.map((r) => ({ name: r.name, sha: r.sha, tag: r.tag, lang: r.lang })),
  }
  await mkdir(outDir, { recursive: true })
  await writeFile(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * Print the run's tables to stdout.
 * @param rows - every row the run produced.
 * @param context - where results went and what the run was.
 * @param context.outDir - the results directory.
 * @param context.manifest - the run manifest.
 */
export function printReport(rows, { outDir, manifest }) {
  const out = (text) => process.stdout.write(`${text}\n`)
  const errors = rows.filter((r) => r.status === 'error')

  out('')
  out(`# Benchmark ${manifest.runId}`)
  out('')
  out(`Node ${manifest.node.version} on ${manifest.platform}, ${manifest.cpus} cores. `
    + `Tokens: ${manifest.tokenizer}.`)
  out(`Budgets in force: default ${manifest.budgets.defaultBudget}, max ${manifest.budgets.maxBudget}.`)
  out('')
  out(markdownTable(
    ['Repo', 'Language', 'Tag', 'Pinned commit'],
    manifest.repos.map((r) => [r.name, r.lang, r.tag ?? '(this repo)', r.sha.slice(0, 12)]),
  ))

  // Three scenarios do not fit the baseline/ratio table, each for its own
  // reason, and forcing them into it printed columns that meant nothing.
  const special = { 'tool-schema-overhead': printSchemaTable, 'workflow-cost': printWorkflowTable, 'index-profile': printIndexTable }
  const measured = rows.filter((r) => !(r.scenario in special))

  for (const scenario of new Set(measured.map((r) => r.scenario))) {
    const summaries = summarise(measured.filter((r) => r.scenario === scenario))
    if (summaries.length === 0) continue
    out('')
    out(`## ${scenario}`)
    out('')
    out(`Baseline: ${BASELINE_LABELS[scenario] ?? 'unspecified'}.`)
    out('')
    // Budget is a column, not a caption, and never omitted: `graph_tokens` is
    // bounded by it, so a ratio read without it is meaningless.
    out(markdownTable(
      ['Repo', 'Budget', 'Calls', 'Errors', 'Baseline (med)', 'Graph (med)', 'Ratio (med)', 'Hit budget'],
      summaries.map((s) => [
        s.repo,
        s.budget,
        s.calls,
        s.errors === 0 ? 0 : `**${s.errors}**`,
        s.baseline,
        s.graph,
        s.ratio === null ? null : `${s.ratio}×`,
        `${s.truncated}/${s.calls} (${s.truncatedShare}%)`,
      ]),
    ))
    if (scenario === 'corpus-baseline') {
      out('')
      out('> These ratios are an **upper bound**. The baseline is every file the index covers, '
        + 'which is what an agent would pay only if it read the whole repository to answer one '
        + 'question. No real agent does that — see `agent-baseline` for the honest comparison.')
    }
  }

  for (const [scenario, print] of Object.entries(special)) {
    const scoped = rows.filter((r) => r.scenario === scenario)
    if (scoped.length > 0) print(out, scoped)
  }

  out('')
  if (errors.length > 0) {
    out(`## ${errors.length} failed call${errors.length === 1 ? '' : 's'}`)
    out('')
    out('Kept in the CSVs with `status=error`, excluded from every aggregate above.')
    out('')
    out(markdownTable(
      ['Repo', 'Scenario', 'Question', 'Tool', 'Error'],
      errors.map((r) => [r.repo, r.scenario, r.question_id, r.tool, r.error]),
    ))
    out('')
  }
  out(`CSVs and manifest: ${outDir}`)
  out('')
}

/**
 * Print the schema-overhead table, on its own.
 * @param out - line writer.
 * @param rows - the scenario's rows.
 */
function printSchemaTable(out, rows) {
  const totals = okRows(rows).filter((r) => r.question_id === 'per-session-total')
  const comparison = totals.find((r) => r.repo === 'comparison')
  const sides = totals.filter((r) => r.repo !== 'comparison')

  out('')
  out('## tool-schema-overhead')
  out('')
  out(`Baseline: ${BASELINE_LABELS['tool-schema-overhead']}.`)
  out('')
  out(markdownTable(
    ['Tool surface', 'Tools', 'Tokens injected per session'],
    sides.map((r) => [r.repo, r.returned_rows, r.graph_tokens]),
  ))
  if (comparison?.ratio) {
    out('')
    out(`The reference surface costs **${comparison.ratio}×** this plugin's, `
      + `every session, before any tool is called.`)
  }
  out('')
  out('> Reported separately on purpose: this is a **fixed per-session** cost, not a per-question '
    + 'one, so it is never folded into the ratios above. Both sides are normalised to the same '
    + '`{name, description, input_schema}` JSON; a host adds framing this cannot see, so the ratio '
    + 'is the durable figure and the absolute token counts are indicative.')
}

/**
 * Print the workflow table.
 *
 * A median over a workflow's steps is not a number anybody wants; the total is.
 * So this reports one row per repository and budget with the end-to-end cost,
 * and how many of the four calls hit the budget on the way.
 * @param out - line writer.
 * @param rows - the scenario's rows.
 */
function printWorkflowTable(out, rows) {
  const measured = okRows(rows)
  const totals = measured.filter((r) => r.question_id.endsWith('#total'))
  const steps = measured.filter((r) => !r.question_id.endsWith('#total'))
  const errors = rows.filter((r) => r.status === 'error').length

  out('')
  out('## workflow-cost')
  out('')
  out(`Baseline: ${BASELINE_LABELS['workflow-cost']}.`)
  out('')
  out(markdownTable(
    ['Repo', 'Budget', 'Calls', 'Total tokens', 'Calls that hit budget'],
    totals
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.budget_limit - b.budget_limit)
      .map((t) => {
        const mine = steps.filter((s) => s.repo === t.repo && s.budget_limit === t.budget_limit)
        const hit = mine.filter((s) => s.truncated === true).length
        return [t.repo, t.budget_limit, t.returned_rows, t.graph_tokens, `${hit}/${mine.length}`]
      }),
  ))
  out('')
  out('> The end-to-end cost of one `code_overview` → `code_find` → `code_relations` → `code_impact` '
    + 'sequence. No baseline: this is what the work costs, not what it saves. A workflow with a '
    + 'failed step reports no total at all, since the missing call would have cost something.')
  if (errors > 0) out(`> ${errors} step(s) failed; their workflows are excluded from the totals above.`)
}

/**
 * Print the index profile.
 *
 * The build figures are cold and the latencies are warm, which is the only
 * combination that describes what an agent meets: it pays the build once and
 * then queries a built index. Both halves are labelled rather than mixed.
 * @param out - line writer.
 * @param rows - the scenario's rows.
 */
function printIndexTable(out, rows) {
  const measured = okRows(rows)
  const builds = measured.filter((r) => r.question_id === 'cold-build')
  const warm = measured.filter((r) => r.question_id.startsWith('warm-'))

  out('')
  out('## index-profile')
  out('')
  out('Cold build, once per repository.')
  out('')
  out(markdownTable(
    ['Repo', 'Files', 'Symbols', 'Edges', 'DB on disk', 'Build'],
    builds.sort((a, b) => a.repo.localeCompare(b.repo)).map((r) => [
      r.repo,
      r.files,
      r.nodes,
      r.edges,
      `${(r.db_bytes / 1e6).toFixed(1)} MB`,
      `${r.elapsed_ms} ms`,
    ]),
  ))
  out('')
  out('Warm query latency, median of 5 after one discarded warm-up.')
  out('')
  out(markdownTable(
    ['Repo', 'Budget', 'Tool', 'Median', 'Tokens', 'CALLS resolved'],
    warm
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.budget_limit - b.budget_limit || a.tool.localeCompare(b.tool))
      .map((r) => [
        r.repo,
        r.budget_limit,
        r.tool,
        `${r.elapsed_ms} ms`,
        r.graph_tokens,
        r.call_resolution === null || r.call_resolution === undefined ? null : `${Math.round(r.call_resolution * 100)}%`,
      ]),
  ))
}
