# dsh-code-graph

[![CI](https://github.com/simomat/dsh-code-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/simomat/dsh-code-graph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D26-5fa04e.svg)](#requirements)

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the
agent **structural access to a codebase**, so exploring it costs a handful of cheap structured tool
calls instead of a read/grep/glob loop over whole files.

Inspired by [`code-review-graph`](https://github.com/tirth8205/code-review-graph), but a native
Cordis plugin rather than an MCP server, TypeScript rather than Python, and deliberately a **small
tool surface** (the reference exposes 30 MCP tools) with a token budget on every result.

## Requirements

- Node **>= 26** (for stable `node:sqlite`)
- `git` on `PATH` (optional; a directory-walk fallback covers its absence)

## Install

Not published to a registry yet — install is from source.

### From a clone

```sh
git clone https://github.com/simomat/dsh-code-graph.git
cd dsh-code-graph
pnpm install              # the `prepare` script builds; `pnpm run build` does it again explicitly
dsh plugin --profile <name> add /absolute/path/to/dsh-code-graph
```

### From a packed tarball

`pnpm pack` produces one locally, and every CI run attaches one as a build artifact. It carries the
built `lib/`, so nothing needs compiling — only its runtime dependencies:

```sh
tar -xzf dsh-code-graph-1.0.0.tgz     # extracts into ./package
cd package && npm install --omit=dev
dsh plugin --profile <name> add "$PWD"
```

### Without installing, for development

```sh
cat > /tmp/cg-patch.yml <<'YAML'
- insert:
    - id: code-graph
      name: '/absolute/path/to/dsh-code-graph/lib/index.js'
YAML
pnpm dsh --profile web --patch /tmp/cg-patch.yml
```

This path names a file rather than the package, so the harness cannot resolve the package by name
and the [browser half](#web-ui) stays hidden. Install into a profile to see it.

## Languages

| Language | How | Extensions |
|---|---|---|
| TypeScript / JavaScript (incl. TSX/JSX) | dedicated walker | `.ts` `.tsx` `.mts` `.cts` `.d.ts` `.js` `.jsx` `.mjs` `.cjs` |
| Java | query pack | `.java` |
| Go | query pack | `.go` (`vendor/` and `testdata/` skipped) |
| Rust | query pack | `.rs` (`target/` skipped) |

## Design

`dsh-code-graph` runs entirely in-process and offline: WASM tree-sitter for parsing, the built-in
`node:sqlite` for storage, `git` (optional) for file enumeration. The index lives outside the
repository and stays incrementally fresh as the agent edits files. Four tools —
`code_overview`, `code_find`, `code_relations`, `code_impact` — read it, each with a token budget
and a confidence score on every edge.

The full write-up — build pipeline, schema diagrams, call resolution, and per-tool result shapes —
is in **[Design.md](Design.md)**.

## Configuration

Every knob lives in one settings namespace, `code-graph`, registered against the harness's user
settings document. Defaults come from the schema, a `config:` block on the plugin's `cordis.yml`
entry layers under them, and the user document wins over both. Where the harness composes a
settings provider, the section is editable from the web UI's plugin configuration; where it does
not, the composed entry is simply what runs.

| Key | Default | Effect |
|---|---|---|
| `defaultBudget` | `1500` | Token budget for a tool result that requests none. |
| `maxBudget` | `6000` | Largest budget a tool call may ask for. |
| `exclude` | `[]` | Extra paths kept out of the index, on top of the built-in list. An entry without a slash matches any path segment (`fixtures`); one with a slash is a prefix from the repository root (`packages/legacy`). |
| `maxFileBytes` | `2097152` | Files above this are skipped as generated rather than authored. |
| `languages` | all four | Families to parse: `typescript` (covers JS/TSX/JSX), `java`, `go`, `rust`. Dropping one skips its files and never loads its grammar. |
| `indexDir` | `$DSH_HOME` | Directory holding the index databases. |

The budgets are read per tool call. Everything else decides what belongs in an index, so changing
one drops the open databases and the next call rebuilds in the background — no restart, and no
rebuild for a repository nobody asks about.

## Web UI

The package ships a browser half (`exports["./client"]`, declared with `dsh.client`) that the
harness's client module system discovers on its own: it scans the live plugin entries for packages
declaring `dsh.client` and serves each one's built bundle, so no rebuild of the web application is
involved. Two surfaces:

- a **card in Settings → Plugins → Plugin configuration**, keyed on the `code-graph` settings
  namespace, editing the table above with staged drafts, per-field override markers and a reset
  back to the composed value;
- a **conversation row for each of the four tools**, showing whether the index was ready, building
  (with the phase and file count it had reached) or absent, how current the answer was, and — for
  `code_overview` — the repository totals.

The row is a snapshot of the call, not a live build monitor: the harness has no tool-progress
event, so a percentage that appeared to advance would be a fiction.

The browser half is only found when the harness can resolve this package **by name** from the
profile directory, which the development `--patch` recipe above does not do (it names a path to
`lib/index.js`). Install into a profile to see it.

## Development

```sh
pnpm install
pnpm run build
pnpm test         # oxlint, then node --test 'tests/**/*.test.mjs'
```

`pnpm test` lints before it runs the suite. Lint config is `.oxlintrc.json`: oxlint's `correctness`
set as errors, plus `no-duplicate-imports` and a `max-lines` warning at 500 code lines (blank lines
and comments excluded) so a module that has outgrown its name says so before the next language
lands. Warnings do not fail the run; errors do. `pnpm run lint` runs it alone.

Tests live under `tests/`, organised by subsystem (`index`, `query`, `languages`, `client`) with
shared fixtures in `tests/helpers/`. **[CONTRIBUTING.md](CONTRIBUTING.md)** has the longer version,
including what adding a language takes.

## Future work

- **Measurements.** The benchmark numbers this README used to carry (full build time, database
  size, node/edge counts, warm `code_find` and `code_overview` latency, share of CALLS resolved,
  typical result size in tokens) were dropped rather than left to rot. They come back once there is
  a reproducible harness for them: a named reference repository, a pinned Node version, and a
  script that produces the table, so a regression is visible rather than anecdotal.
- **More languages.** Query packs make a new language a wasm grammar plus a query file with
  `@definition.*` / `@call` / `@heritage.*` captures, plus a `noiseMethods` list — Python, C# and
  C++ are the obvious next candidates. See [Design.md](Design.md#parsing).

## License

[MIT](LICENSE) © Matthias Simon
