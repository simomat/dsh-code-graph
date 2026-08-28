/**
 * Scenario D — what a session pays before it does anything.
 *
 * Tool definitions are injected into every session's prompt prefix, once,
 * whether or not a single tool is ever called. That makes this a **fixed
 * per-session cost** rather than a per-question one, and it is the one place
 * where a small tool surface is measurable rather than merely asserted. The
 * README already makes the small-surface claim; this is what it costs.
 *
 * Three things this scenario is careful not to overstate.
 *
 * **It is reported on its own.** The number is never folded into a per-question
 * ratio: those are per call, this is per session, and adding them would produce
 * a figure that describes no real workload.
 *
 * **It is not repository-specific.** It runs once per invocation, with no repo
 * and no budget, because neither changes it.
 *
 * **The absolute figure is indicative.** Both sides are normalised to the same
 * `{name, description, input_schema}` JSON, but a host adds its own framing
 * around each definition that this cannot see. The ratio between the two sides
 * survives that; the absolute token count is an approximation of it.
 */
import { graphToolSpecs } from '../../src/tools/specs.ts'
import { canonicalise, loadReferenceTools, parametersToJsonSchema } from '../reference.mjs'
import { makeRow, ratio } from '../rows.mjs'

/**
 * This plugin's tool definitions, in the shape a host would inject.
 * @returns Canonical tool definitions.
 */
export function ownTools() {
  return graphToolSpecs.map((spec) => canonicalise({
    name: spec.name,
    description: spec.description,
    input_schema: parametersToJsonSchema(spec.parameters),
  }))
}

/**
 * Run the scenario. Once per invocation, not once per repository.
 * @param context - `{ base, counter, benchDir }`.
 * @returns Rows.
 */
export async function run({ base, counter, benchDir }) {
  const snapshot = await loadReferenceTools(benchDir)
  const rows = []

  const sides = [
    { id: 'dsh-code-graph', tools: ownTools() },
    { id: `${snapshot.package}@${snapshot.version}`, tools: snapshot.tools.map(canonicalise) },
  ]

  const totals = new Map()
  for (const side of sides) {
    let total = 0
    let realTotal = 0
    for (const tool of side.tools) {
      const counted = counter.count(tool)
      total += counted.estimated
      if (counted.real !== null) realTotal += counted.real
      rows.push(makeRow({
        ...base,
        scenario: 'tool-schema-overhead',
        repo: side.id,
        repo_sha: null,
        question_id: `tool:${tool.name}`,
        tool: tool.name,
        // No budget applies: a tool definition is not a budgeted result.
        budget_limit: null,
        graph_tokens: counted.estimated,
        real_tokens: counted.real,
        est_real_ratio: counted.ratio,
      }))
    }
    totals.set(side.id, { total, realTotal, count: side.tools.length })
    rows.push(makeRow({
      ...base,
      scenario: 'tool-schema-overhead',
      repo: side.id,
      repo_sha: null,
      question_id: 'per-session-total',
      tool: 'all-tools',
      budget_limit: null,
      graph_tokens: total,
      real_tokens: counter.verify ? realTotal : null,
      returned_rows: side.tools.length,
    }))
  }

  // The comparison row. `baseline_tokens` is the reference's surface and
  // `graph_tokens` this plugin's, so the ratio reads the same way as every other
  // scenario's: how many times more the alternative costs.
  const own = totals.get('dsh-code-graph')
  const reference = totals.get(`${snapshot.package}@${snapshot.version}`)
  rows.push(makeRow({
    ...base,
    scenario: 'tool-schema-overhead',
    repo: 'comparison',
    repo_sha: null,
    question_id: 'per-session-total',
    tool: 'all-tools',
    budget_limit: null,
    baseline_kind: `${reference.count} reference tools vs ${own.count} own, per session`,
    baseline_tokens: reference.total,
    graph_tokens: own.total,
    ratio: ratio(reference.total, own.total),
  }))

  return rows
}
