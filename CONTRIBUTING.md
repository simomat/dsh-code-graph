# Contributing

Thanks for looking. This is a small, deliberately small-surfaced plugin — four tools, one settings
namespace — so the most useful contributions are usually a new language pack, a call-resolution fix,
or a test that pins down something the graph currently gets wrong.

Read **[Design.md](Design.md)** before a non-trivial change. It is the reasoning behind the schema,
the call resolution, and the shape of every tool result; a change that contradicts it needs to
update it in the same pull request.

## Toolchain

- **Node >= 26.** Non-negotiable, and not only for `engines`: the tests import `src/*.ts` directly
  and rely on Node's type stripping, and storage uses the built-in `node:sqlite`.
- **pnpm 11.22.0**, pinned in `packageManager`. `corepack enable` picks it up on its own.
- `git` on `PATH` is optional at runtime (a directory walk covers its absence), but the freshness
  tests shell out to it.

```sh
pnpm install
pnpm run build      # tsc (server) + tsc (client types) + tsdown (browser bundle)
pnpm test           # oxlint, then node --test
```

Note that the root `prepare` script is a full build, so a plain `pnpm install` also builds. CI
installs with `--ignore-scripts` and builds as a separate step so failures stay attributable.

## Tests

`node --test 'tests/**/*.test.mjs'`, organised by subsystem rather than by feature:

| Directory | Covers |
|---|---|
| `tests/index/` | Storage, incremental freshness, git scanning, the index manager |
| `tests/query/` | Budgeting, resolution, traversal, overview, limits |
| `tests/languages/` | One suite per language, asserting extraction against a fixture repository |
| `tests/client/` | The browser half's settings form and tool-row models |
| `tests/bench/` | The benchmark harness: token counting, grep ranking, truncation recording, error exclusion |
| `tests/config.test.mjs`, `tests/tools.test.mjs` | Settings composition, tool specs and argument guards |

Shared machinery lives in `tests/helpers/`: `fixture.mjs` (a temp repository plus the graph built
over it), `git.mjs`, `manager.mjs`, `repo.mjs` (the shared TypeScript repository the freshness
suites index), `fakes.mjs`, and `invariants.mjs` (`assertFtsConsistent` and friends).

Fixture *content* is intentionally not shared across the language suites. The exact-count
assertions ("indexes 9 files") only mean something when the source a test asserts against sits in
the same file as the numbers. Follow that: a new language suite writes its own fixture.

Run one suite while iterating:

```sh
node --test tests/languages/go.test.mjs
```

## Benchmarks

`pnpm run bench` produces the numbers in the README's Measurements section. It clones five pinned
reference repositories, builds a fresh index over each, and writes CSVs under `bench/results/`.
**[bench/README.md](bench/README.md)** is the reproduction recipe — read it before changing a
question, a pinned SHA or the token counter, since any of the three moves every number.

Two rules there are not negotiable, because breaking either turns a failure into an apparent win:
a thrown tool call is recorded with `status=error` and excluded from every aggregate, and no ratio
is printed without the budget that bounded it in the same table.

## Lint

`pnpm run lint` is oxlint with `.oxlintrc.json` over `src`, `tests` and `bench`: the `correctness`
category as errors, plus
`no-duplicate-imports`, plus a `max-lines` **warning** at 500 code lines (blank lines and comments
excluded, and off for `tests/**`). Warnings do not fail the run; errors do. The line limit is a
smell detector, not a rule — a module that outgrows its name should say so before the next language
lands.

## Adding a language

The cheapest path, and the one Java, Go and Rust all take:

1. A tree-sitter **WASM** grammar. `src/parse/loader.ts` is WASM-only by design — it reads the
   `.wasm` shipped in the grammar package and never builds native bindings, which is why
   `pnpm-workspace.yaml` denies those install scripts.
2. A **query pack** under `src/parse/langs/`: a tree-sitter query with `@definition.*`, `@call` and
   `@heritage.*` captures, plus a `noiseMethods` set. `src/parse/langs/go.ts` is the worked example
   with commentary on the three shapes the Java defaults get wrong; `Design.md` §Parsing describes
   the contract.
3. Registration in `src/parse/langs/registry.ts`, the extension mapping, and the `languages`
   setting so the family can be switched off.
4. Import resolution in `src/parse/imports/`, if the language's module system differs enough to
   need it.
5. A suite in `tests/languages/`, with its own fixture.

Keep `noiseMethods` conservative. As the Go pack notes, idiomatic method names are ordinary English
verbs, so an over-broad list drops project calls far more often than library ones.

## Pull requests

Small and focused beats comprehensive. Fill in the checklist in the template, and say in the
description what you *chose not to* do — this codebase's comments carry that kind of reasoning and
reviews go faster when the PR does too.
