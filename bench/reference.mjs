/**
 * The reference project's tool definitions, for the schema-overhead scenario.
 *
 * Captured rather than transcribed. Hand-copying 30 tool schemas into this
 * repository would produce a number nobody could check and that would drift the
 * first time upstream changed a description — and the whole claim being measured
 * is about the size of those descriptions.
 *
 * Two paths, deliberately:
 *
 * - **live**, spawning `uvx code-review-graph@<pinned> serve` and asking it over
 *   MCP stdio, which is how the snapshot gets refreshed;
 * - **snapshot**, reading the committed JSON under `bench/fixtures/`, which is
 *   what CI and any machine without `uvx` uses.
 *
 * The snapshot is the default. A benchmark that needed PyPI to be reachable
 * before it could produce a number would not be reproducible in the sense that
 * matters.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { REFERENCE } from './config.mjs'

/** Where a captured snapshot lives. */
export function snapshotPath(benchDir, version = REFERENCE.version) {
  return join(benchDir, 'fixtures', `reference-tools.${version}.json`)
}

/**
 * Ask an MCP stdio server for its tool list.
 *
 * A minimal client: initialize, the initialized notification, then `tools/list`.
 * Enough to read a tool list and nothing more, because nothing more is measured.
 * @param options - how to start the server.
 * @param options.command - the executable.
 * @param options.args - its arguments.
 * @param options.timeoutMs - how long to wait before giving up.
 * @returns The server's `tools` array.
 */
export function fetchToolsOverMcp({ command, args, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      if (error) reject(error)
      else resolve(value)
    }

    const timer = setTimeout(
      () => finish(new Error(`${command} did not answer tools/list in ${timeoutMs}ms\n${stderr.slice(-2000)}`)),
      timeoutMs,
    )

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)

    child.stdout.on('data', (chunk) => {
      buffer += chunk
      // Newline-delimited JSON-RPC. A partial trailing line stays in the buffer.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        }
        if (message.id === 2) {
          if (message.error) finish(new Error(`tools/list failed: ${JSON.stringify(message.error)}`))
          else finish(null, message.result?.tools ?? [])
        }
      }
    })

    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`${command} exited with ${code} before answering\n${stderr.slice(-2000)}`))
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-code-graph-bench', version: '1.0.0' },
      },
    })
  })
}

/**
 * Capture the pinned reference server's tools and write the snapshot.
 * @param benchDir - the `bench/` directory.
 * @returns `{ path, tools, version }`.
 */
export async function captureReferenceTools(benchDir) {
  const pinned = `${REFERENCE.package}@${REFERENCE.version}`
  const tools = await fetchToolsOverMcp({ command: REFERENCE.command, args: ['--from', pinned, REFERENCE.package, 'serve'] })
  const path = snapshotPath(benchDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({
    package: REFERENCE.package,
    version: REFERENCE.version,
    capturedWith: `${REFERENCE.command} --from ${pinned} ${REFERENCE.package} serve`,
    toolCount: tools.length,
    tools: tools.map(canonicalise).sort((a, b) => a.name.localeCompare(b.name)),
  }, null, 2)}\n`)
  return { path, tools, version: REFERENCE.version }
}

/**
 * Load the committed snapshot.
 * @param benchDir - the `bench/` directory.
 * @returns The parsed snapshot.
 */
export async function loadReferenceTools(benchDir) {
  const path = snapshotPath(benchDir)
  if (!existsSync(path)) {
    throw new Error(
      `no reference tool snapshot at ${path}. Capture one with:\n`
      + '  pnpm run bench -- --capture-reference',
    )
  }
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * Reduce a tool definition to the three things a host injects.
 *
 * Both sides of the comparison go through this, so neither is measured with
 * fields the other does not have. It is also why the absolute number is only
 * indicative: a host's own wire format adds framing this cannot know about.
 * @param tool - a tool definition from either side.
 * @returns `{ name, description, input_schema }`.
 */
export function canonicalise(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? tool.input_schema ?? tool.parameters ?? {},
  }
}

/**
 * Convert this plugin's parameter spec into the JSON Schema an MCP host injects.
 *
 * Without this the comparison would be rigged. Our specs use the harness's
 * compact `{ name: { type, description, required } }` form; an MCP server
 * publishes a full JSON Schema object. Measuring one against the other would
 * credit this plugin for an encoding difference rather than for having four
 * tools instead of thirty. Same information, same shape, then count.
 * @param parameters - a `ParameterSchemaSpec` from `src/tools/specs.ts`.
 * @returns An equivalent JSON Schema object.
 */
export function parametersToJsonSchema(parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec
    properties[name] = rest
    if (isRequired) required.push(name)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}
