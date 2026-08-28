# Benchmark harness

Reproducible token-consumption measurements for `dsh-code-graph`: a pinned set of reference
repositories, a pinned Node version, and a script that produces the tables.

**Looking for the numbers?** They are in **[RESULTS.md](RESULTS.md)**. This file is how they were
produced and how to reproduce them.

Everything here is a **dev dependency**. The plugin's runtime dependency set does not grow.

## What it measures

Five scenarios, kept side by side because they answer different questions. Quoting only one of them
would be the mistake the reference project makes with its whole-corpus ratio.

| Scenario | Baseline | Answers |
|---|---|---|
| `corpus-baseline` | every file the index covers | How much of a repository is the graph standing in for? **Upper bound.** |
| `agent-baseline` | grep-rank, then read the top 3 files | Is the graph cheaper than a grep-and-read agent? **The honest number.** |
| `workflow-cost` | none | What does a realistic four-call sequence cost end to end? |
| `tool-schema-overhead` | the reference's 30 MCP tools | What does the tool surface cost every session, before any work? |
| `index-profile` | none | Build time, index size, node/edge counts, warm latency, CALLS resolved. |

`corpus-baseline` is labelled an upper bound everywhere it is printed, because no real agent reads a
whole repository to answer one question. `agent-baseline` is the one the plugin's pitch rests on.

## What is borrowed, and what is ours

The methodology here is substantially [`code-review-graph`](https://github.com/tirth8205/code-review-graph)'s.
Its [`docs/REPRODUCING.md`](https://github.com/tirth8205/code-review-graph/blob/main/docs/REPRODUCING.md)
was read before this harness was designed, and a reader comparing the two projects will find about
half the scenarios parallel. Drawing the line explicitly, because "inspired by" is doing real work
in that sentence:

**Taken from the reference, and credited:**

- Keeping several token benchmarks side by side rather than quoting one headline number.
- `chars / 4` as a flagged estimate, justified by a committed calibration table against a real tokenizer.
- Determinism as a hard requirement: pinned upstream SHAs instead of `HEAD`, full clones rather than
  shallow ones, a documented machine and runtime.
- **A thrown tool call is not a measurement** — kept in the CSV with `status=error` for forensics,
  excluded from every aggregate. The reference documents two historical bugs of exactly that shape,
  and [`tests/bench/aggregate.test.mjs`](../tests/bench/aggregate.test.mjs) exists because of them.
- Committing dated result CSVs at all.

**Scenarios that have a counterpart upstream:**

| Here | There |
|---|---|
| `agent-baseline` | `eval/benchmarks/agent_baseline.py` |
| `corpus-baseline` | `token_benchmark.py` (standalone) |
| `workflow-cost` | `eval/token_benchmark.py` |
| `index-profile` | `eval/benchmarks/build_performance.py` |

**New here:**

- **`tool-schema-overhead`.** The reference exposes 30 MCP tools and never measures what they cost
  to inject. It is a fixed per-session cost, independent of question, repository and budget — the
  three things every other figure is sensitive to.
- **The budget confound machinery.** Every row records `budget_limit`, `truncated` and
  `truncation_cause`; every scenario runs at both budgets; no aggregate prints without a budget
  column. The reference's tool has no budget concept, so there was nothing to copy — this is the
  methodology this plugin needed and had to invent.
- **One CSV schema across every scenario**, rather than a schema per benchmark.

**One deliberate disagreement.** The reference quotes the whole-corpus ratio as its headline. This
harness computes the same number and labels it an upper bound that should not be quoted, because it
is a baseline no real agent pays.

**What the reference measures that this does not.** Four of its benchmarks —
`impact_accuracy`, `multi_hop_retrieval`, `search_quality`, `flow_completeness` — ask whether the
answers are *correct*. Everything here measures only cost. That gap is real, and it is why
[`RESULTS.md`](RESULTS.md) opens its limitations with "not an accuracy measurement".

## Prerequisites

- **Node 26.7.0**, pinned in [`.tool-versions`](../.tool-versions). The harness hard-fails below
  Node 26 (`node:sqlite` and type stripping are both load-bearing) and warns — recording the
  discrepancy in every row — on a different patch release.
- **pnpm 11.22.0**, pinned in `packageManager`.
- **`git` on `PATH`**, for cloning the reference repositories.
- **~75 MB of disk** for the clone cache in `bench/.repos/` (gitignored).
- **`uvx`** (Python), *only* to refresh the reference tool snapshot. Not needed for a normal run:
  the snapshot in `bench/fixtures/` is committed.

## Commands

```sh
pnpm run bench                                             # everything
pnpm run bench -- --scenario agent-baseline --repo express  # one scenario, one repo
pnpm run bench -- --scenario agent-baseline,workflow-cost   # several
pnpm run bench -- --verify                                  # add real-tokenizer columns
pnpm run bench -- --calibrate                               # + the chars/4 calibration table
pnpm run bench -- --out /tmp/somewhere                      # results elsewhere
pnpm run bench -- --capture-reference                       # refresh the MCP tool snapshot (needs uvx)
```

Results land in `bench/results/<YYYY-MM-DD>/`: one CSV per scenario and repository, plus a
`manifest.json` recording the pinned commits, the Node version, the budgets and the machine. A CSV
without that manifest is a table of numbers nobody can reproduce.

### What gets committed, and for how long

`bench/results/` is **committed**, at roughly 60 KB per run. That is what makes the published
figures auditable rather than asserted: the per-question rows are how a reader checks a median, sees
the spread behind it, or confirms which answers were truncated.

The weekly CI job uploads its results as a build artifact and **never commits them**, so the
directory only grows when someone deliberately adds a run. Keep it that way:

- **Commit the run that the published numbers came from.** If [`RESULTS.md`](RESULTS.md) quotes it,
  its CSVs and manifest belong in the tree.
- **Prune rather than accumulate.** Keep the current run, plus at most one older generation to
  compare against. Delete the rest — git history still has them if anyone needs one back.
- **Never edit a committed CSV.** Re-run the harness and replace the directory. A hand-touched row
  is indistinguishable from a measured one.

`bench/.repos/` (the ~75 MB clone cache) is gitignored and must stay that way.

## Expected runtime

Measured on Linux x64, 22 cores, Node 26.7.0:

- **full run, warm clone cache: ~7 s.** All five scenarios, six repositories, both budgets.
- **first run: add the clone time.** Five full clones, ~75 MB. This dominates and is entirely
  network-bound; subsequent runs only verify the SHAs.
- `--verify` / `--calibrate` add a few seconds for the real tokenizer.

Index builds are the bulk of the measured work: 133 ms (this repo) to 840 ms (hono).

## What is and is not deterministic

**Deterministic.** Two consecutive full runs produce byte-identical CSVs except for `run_id`, `date`
and `elapsed_ms`. That is asserted by the checks below and holds because:

- reference repositories are **full clones at pinned commits**, verified with `git rev-parse HEAD`
  *after* checkout — a mismatch aborts the run loudly rather than annotating a row;
- the working tree is checked clean after checkout, so a stray edit in a cached clone cannot travel
  between runs;
- the index is built **fresh into a temp directory every run** and deleted afterwards;
- questions, workflows and the stopword list are committed data, and there is no randomness anywhere;
- `self` is *cloned from this working copy* rather than measured in place, so the tree under test is
  clean even when yours is not.

**Not deterministic.** `elapsed_ms` everywhere, and therefore every figure in the warm-latency half
of `index-profile`. Treat those as indicative and compare them only within a run. Absolute build
times obviously depend on the machine, which is why `manifest.json` records it.

**A note on pins.** Each `sha` in `bench/config.mjs` is the *commit* a tag points at. For an
annotated tag that is not the tag object — use `git rev-parse <tag>^{commit}`. Getting this wrong is
caught immediately, with a message saying so.

## The budget confound — read this before reading any ratio

Every tool result is capped by `defaultBudget` (1500) and `maxBudget` (6000). **`graph_tokens` is
therefore bounded by configuration, not only by what the graph found.** A reduction ratio quoted
without the budget beside it is close to meaningless, so:

- every row records `budget_limit`, `truncated` and `truncation_cause`;
- every scenario runs at **both** budgets;
- no aggregate is ever printed without the budget in the same table.

**And truncation at the default budget is common.** From the run below:

| Budget | Results that hit it (agent-baseline) |
|---|---|
| 1500 (default) | **17 / 30 — 56%** |
| 6000 (max) | 4 / 30 — 13% |

That is a real finding about the tool, not a blemish. At the default budget more than half the
answers are cut off, and the ratio is correspondingly flattering — `gson` goes from 17.62× at 1500
to 5.45× at 6000 precisely because at 1500 it was truncated in all five questions. Read the two
budget rows together or not at all.

### `truncated` conflates causes

The flag means "rows are missing", not "the budget bit", and each tool merges a different set of
causes into it. `truncation_cause` reports what each result can actually support:

| Value | Meaning |
|---|---|
| `none` | Everything the tool found came back. |
| `budget` | The token budget dropped rows. |
| `cap` | A pre-budget SQL cap dropped rows (30 per relation, 100 per BFS layer). |
| `both` | Both, provably. |
| `unknown` | The result cannot say — see below. |

`unknown` is almost always `code_overview`, whose SQL pre-caps (40 modules, 15 hubs, 12 entry
points) are invisible to its `truncated` flag and whose result reports no totals. A section sitting
exactly on its cap may or may not have lost rows and nothing in the response settles it. Recording
`none` there would claim a complete answer that was never established. For `code_impact`, a `budget`
cause does not *rule out* the per-layer BFS cap having also fired, because the result folds both
into one flag.

Observed across the full run: 78 `none`, 43 `budget`, 27 `unknown`, 11 `both`, 9 `cap`.

## Token counting

The default is `chars / 4`, identical to `estimateTokens` in `src/query/budget.ts` — the measurement
and the budget that shaped it must be on one scale. Every default row carries `estimated: true`.

`--verify` recounts with `gpt-tokenizer` (`cl100k_base`) and adds `real_tokens` and `est_real_ratio`.

### Calibration

300 files, 2.19 M characters, every *n*-th indexed file by sorted path per repository (spread rather
than the first *n*, which would sample one directory of one language and call it a calibration):

| Repo | Language | Files | Chars | chars/4 estimate | cl100k real | Ratio |
|---|---|---|---|---|---|---|
| express | javascript | 50 | 188,958 | 47,256 | 47,733 | 0.99 |
| hono | typescript | 50 | 201,318 | 50,343 | 54,137 | 0.93 |
| gin | go | 50 | 155,243 | 38,829 | 43,944 | 0.884 |
| gson | java | 50 | 419,051 | 104,783 | 92,636 | 1.131 |
| ripgrep | rust | 50 | 915,147 | 228,809 | 222,109 | 1.03 |
| self | typescript | 50 | 309,191 | 77,316 | 78,598 | 0.984 |
| **overall** | — | 300 | 2,188,908 | 547,336 | 539,157 | **1.015** |

In aggregate `chars / 4` is within **+1.5%**. Per language it is not nearly that good: Go is
over-tokenized by the estimate (0.884) and Java under-tokenized (1.131), a spread of about ±13%.
A cross-language aggregate is fine; a single-language figure deserves `--verify`.

**This does not make the numbers model-accurate.** `dsh-code-graph` targets DeepSeek Harness models
and `cl100k_base` is OpenAI's. A close ratio says `chars / 4` is a sane shortcut for source code. It
does not say these counts are what a DeepSeek model would bill.

## Reference repositories

| Repo | Tag | Commit | Language |
|---|---|---|---|
| [expressjs/express](https://github.com/expressjs/express) | v5.2.1 | `dbac741a49a5a64336b70c06e85c2e2706e36336` | JavaScript |
| [honojs/hono](https://github.com/honojs/hono) | v4.13.5 | `06880c4a2b04de9dd74217f26dd831209b9c01f1` | TypeScript |
| [gin-gonic/gin](https://github.com/gin-gonic/gin) | v1.10.1 | `b5af7796535d97d9c7af42539af01d787fcb3b4d` | Go |
| [google/gson](https://github.com/google/gson) | gson-parent-2.14.0 | `3ff35d6269894901ab8006258395aafc4b9765cd` | Java |
| [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | 14.1.1 | `4649aa9700619f94cf9c66876e9549d83420e16c` | Rust |
| this repo | — | recorded per run in `manifest.json` | TypeScript |

All four supported languages, plus this repository. **express** and **gin** are deliberately shared
with the reference project's benchmark set so the two projects' numbers can be compared.

## Errored calls

A thrown tool call is **not a measurement**. The row stays in the CSV with `status=error` and the
message, for forensics, and is excluded from every aggregate. It carries no token columns at all —
not zeros. This is the reference project's documented bug class: a thrown call recorded as
`graph_tokens = 0` produces a ratio of `baseline / 1` and turns a failure into a win.
`tests/bench/aggregate.test.mjs` is the regression test.

## Layout

```
bench/
  run.mjs            CLI: arg parsing, repo prep, scenario dispatch
  config.mjs         pinned repos, budgets, stopwords, reference pin
  questions.mjs      the fixed question set and the workflows
  repos.mjs          clone, pin verification, Node version check
  graph.mjs          fresh index per run; the tool-shaped call wrapper
  grep.mjs           the grep-and-read loop the agent baseline simulates
  tokens.mjs         chars/4, and the real tokenizer behind --verify
  calibrate.mjs      the chars/4 calibration
  reference.mjs      MCP capture of the reference's 30 tool schemas
  rows.mjs           row construction and truncation-cause derivation
  csv.mjs            the one CSV schema
  report.mjs         aggregates; the error-exclusion rule lives here
  output.mjs         the printed tables and the run manifest
  scenarios/         one module per scenario
  fixtures/          committed reference tool snapshot
  results/           committed results, one directory per date
  README.md          this file — method, determinism, troubleshooting
  RESULTS.md         the published findings
```

Tests are under `tests/bench/`, following the repo's usual layout.

## Two things the harness measures that the docs get wrong

Both are pre-existing, and both affect how these numbers read. They are reported rather than
silently worked around:

1. **`src/index.ts` promises a budget field that three tools do not emit.** The `max_tokens`
   description says "Every result reports the budget it actually ran under", and the comment above
   it says "Every result reports `budget.limit`". Only `code_find` does; `code_overview`,
   `code_relations` and `code_impact` return no `budget` field. A tool description is part of the
   prompt prefix, so this is a claim the model is told and cannot check. The harness therefore
   counts tokens itself rather than trusting a `budget.used` that mostly is not there.
2. **`Design.md` claims a per-tool budget default that does not exist.** It says the default is
   "1500 (2000 for `code_impact`)". `clampBudget` has no per-tool default — `code_impact` gets 1500
   like the rest.

## Troubleshooting

**`pinned commit … does not exist … even after fetching`** — the `sha` in `bench/config.mjs` is
wrong, most likely an annotated tag's *tag object* rather than its commit. Fix with
`git rev-parse <tag>^{commit}`.

**`checked out X but the pin is Y. Refusing to measure…`** — the checkout did not land where the
config says. Delete the repository's directory under `bench/.repos/` and rerun to re-clone.

**`working tree is dirty after checkout`** — something wrote into a cached clone. Delete that
directory under `bench/.repos/` and rerun.

**`bench requires Node >= 26`** — the harness imports `src/*.ts` directly and relies on Node's type
stripping and `node:sqlite`. Use the version in `.tool-versions`.

**`warning: running Node X, but .tool-versions pins Y`** — not fatal. Numbers stay comparable only
against runs on the same version, and the running version is in every row and in the manifest.

**`no reference tool snapshot at …`** — only possible if `bench/fixtures/` was deleted. Restore it
from git, or recapture with `pnpm run bench -- --capture-reference` (needs `uvx`).

**`uvx … did not answer tools/list`** — only affects `--capture-reference`. Normal runs use the
committed snapshot. Check `uvx code-review-graph --version` works standalone.

**A run is slow the first time** — that is the five full clones. They are cached in `bench/.repos/`
and reused after a SHA check.
