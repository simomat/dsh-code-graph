# Benchmark results

**What one structural tool call costs against a grep-and-read loop.**

30 questions · 6 repositories · 247 measurements · 0 failed calls · Node 26.7.0, Linux x64 · 27 Aug 2026

## At a glance

- **18.1× fewer tokens** per question — one `code_graph` call vs. grep + reading the top 3 files (median).
- **12.7×** at the maximum budget. The gap between the two is truncation, not efficiency.
- **56% of answers were cut off** at the stock budget. This is the number that qualifies every other number here.
- **6.7× smaller tool surface** — 1,091 tokens per session against 7,307 for a 30-tool MCP server. Fixed cost, paid before any work.
- **Spread is 1.6×–114.5×** across individual questions. The median is the honest summary.
- **Sub-second index builds** on every repository; warm `code_find` in 0.3–0.8 ms.

## Cost per question

Median over 5 questions per repository. Budgets are `defaultBudget` (1,500) and `maxBudget` (6,000).

| Repository | Language | grep + read 3 | graph @1500 | graph @6000 | **@1500** | **@6000** |
|---|---|--:|--:|--:|--:|--:|
| express | JavaScript | 8,417 | 670 | 670 | **12.9×** | 12.9× |
| hono | TypeScript | 28,254 | 1,179 | 1,199 | **39.2×** | 27.7× |
| gin | Go | 9,610 | 1,428 | 1,487 | **6.5×** | 4.3× |
| gson | Java | 26,660 | 1,404 | 3,424 | **17.6×** | 5.5× |
| ripgrep | Rust | 55,418 | 1,430 | 1,724 | **36.9×** | 24.6× |
| dsh-code-graph | TypeScript | 10,918 | 418 | 418 | **18.1×** | 18.1× |
| **all 30 questions** | — | **16,984** | **1,123** | **1,133** | **18.1×** | **12.7×** |

> [!WARNING]
> **Never quote a ratio from this table without its budget.**
> Results are capped by configuration, so the cheap column is partly cheap because it was cut off.
> `gson` drops from 17.6× to 5.5× between the two budgets — the graph did not get worse, it was
> allowed to say more.

By tool, at the default budget:

| Tool | Median reduction | Questions |
|---|--:|--:|
| `code_find` | 33.6× | 12 |
| `code_relations` | 25.1× | 6 |
| `code_impact` | 15.4× | 6 |
| `code_overview` | 6.4× | 6 |

- `code_find` does best — it returns a path, line and signature where the baseline reads whole files.
- `code_overview` does worst and is **the weakest comparison here**: there is no real grep equivalent for "what is the module layout". An agent without a graph doesn't ask that, it just starts reading.

## Tool-surface overhead

Tool definitions enter every session's prompt before any work happens.

| Tool surface | Tools | Tokens per session |
|---|--:|--:|
| `dsh-code-graph` | 4 | **1,091** |
| `code-review-graph` 2.3.7 | 30 | 7,307 |

- **6.7× less, every session.** Probably the most defensible number in this report.
- Independent of question, repository and budget — the three things every other figure is sensitive to.
- Both sides normalised to the same `{name, description, input_schema}` JSON, so this isn't crediting an encoding difference.
- A host adds framing this can't see: **the ratio is durable, the absolute counts are indicative.**

---

## The budget confound

| Budget | Answers truncated | Share | Median reduction |
|---|---|--:|--:|
| 1,500 (default) | 17 / 30 | **56%** | 18.1× |
| 6,000 (maximum) | 4 / 30 | 13% | 12.7× |

Per repository:

| Repository | @1500 | @6000 |
|---|--:|--:|
| gson | 5/5 | 2/5 |
| ripgrep | 4/5 | 0/5 |
| gin | 3/5 | 1/5 |
| hono | 3/5 | 1/5 |
| express | 1/5 | 0/5 |
| dsh-code-graph | 1/5 | 0/5 |

- This is **a finding about the tool**, not a flaw in the measurement.
- The default budget is tight for real-world repositories.
- Any single-budget figure is partly measuring the budget rather than the graph.
- The harness refuses to print an aggregate table without a budget column.

### `truncated` doesn't say *why*

The flag means "rows are missing", not "the budget bit". Each tool folds different causes into it.

| Cause | Count | Meaning |
|---|--:|---|
| `none` | 78 | Everything found came back. |
| `budget` | 43 | The token budget dropped rows. |
| `unknown` | 27 | The result cannot say. |
| `both` | 11 | Budget and a pre-budget cap, provably. |
| `cap` | 9 | A pre-budget cap only. |

- All 27 `unknown` rows are `code_overview`. Its SQL pre-caps (40 modules, 15 hubs, 12 entry points) never reach its `truncated` flag, and it reports no totals.
- A section sitting exactly on its cap may or may not have lost rows — nothing in the response settles it.
- Recording `none` there would claim a completeness that was never established.

## What a real workflow costs

Absolute cost, no baseline: `code_overview` → `code_find` → `code_relations` → `code_impact`.

| Repository | @1500 | Calls cut | @6000 | Calls cut |
|---|--:|--:|--:|--:|
| express | 2,050 | 0/4 | 2,050 | 0/4 |
| hono | 3,716 | 3/4 | 6,903 | 0/4 |
| gin | 4,459 | 3/4 | 9,932 | 1/4 |
| gson | 4,785 | 4/4 | 14,808 | 2/4 |
| ripgrep | 4,406 | 3/4 | 8,463 | 0/4 |
| dsh-code-graph | 2,580 | 1/4 | 2,653 | 0/4 |

- Orienting in an unfamiliar repository and scoping a change: **2,000–4,800 tokens** at the default budget.
- Up to **14,800** at the maximum — which is how to read the left column honestly: cheap partly because incomplete.

## The index

| Repository | Files | Symbols | Edges | Index | Build | CALLS resolved |
|---|--:|--:|--:|--:|--:|--:|
| express | 142 | 746 | 2,238 | 1.9 MB | 221 ms | 49% |
| hono | 390 | 2,693 | 9,059 | 8.2 MB | 840 ms | 58% |
| gin | 91 | 1,270 | 8,511 | 6.7 MB | 301 ms | 93% |
| gson | 262 | 4,398 | 28,473 | 30.9 MB | 721 ms | 64% |
| ripgrep | 98 | 3,238 | 10,205 | 6.5 MB | 471 ms | 96% |
| dsh-code-graph | 74 | 576 | 1,954 | 1.4 MB | 133 ms | 67% |

- Warm `code_find`: **0.3–0.8 ms**. Warm `code_overview`: **2.5–30.9 ms**. Median of 5 after a discarded warm-up.
- Builds are sub-second everywhere, so the cold-start cost an agent pays once is small.
- **Call resolution tracks module system, not language.** ripgrep 96% and gin 93%; express 49%, because its CommonJS `require` graph is largely not statically resolvable. gson's 64% reflects reflection-heavy call sites.
- Unresolved edges are kept and marked with a confidence score rather than dropped — a low percentage is visible in the data, not hidden by it.

<details>
<summary><b>Corpus upper bound</b> — reproduced for comparability, not a result</summary>

<br>

The reference project's headline benchmark compares against the *entire repository*.

| Repository | Whole corpus | graph @1500 | Ratio @1500 | @6000 |
|---|--:|--:|--:|--:|
| express | 135,150 | 670 | 201.7× | 201.7× |
| hono | 663,871 | 1,179 | 563.1× | 553.7× |
| gin | 134,615 | 1,428 | 94.3× | 90.5× |
| gson | 489,711 | 1,404 | 348.8× | 143.0× |
| ripgrep | 423,601 | 1,430 | 296.2× | 245.7× |
| dsh-code-graph | 116,340 | 418 | 278.3× | 278.3× |

- **These are upper bounds and should not be quoted as results.** No agent reads a whole repository to answer one question.
- The number rises with repository size, not with the graph getting better — hono scores highest purely because it has the most source to not read.
- This is the part of the reference methodology worth *not* copying.

</details>

<details>
<summary><b>How tokens were counted</b> — and the calibration table</summary>

<br>

Default is `chars / 4`, matching the estimator the plugin's own budgets use, so the measurement and
the budget shaping it are on one scale. Calibrated against `gpt-tokenizer` (`cl100k_base`) over 300
files, sampled as every *n*-th indexed file by sorted path.

| Repository | Language | Characters | `chars/4` | cl100k | Ratio |
|---|---|--:|--:|--:|--:|
| express | JavaScript | 188,958 | 47,256 | 47,733 | 0.990 |
| hono | TypeScript | 201,318 | 50,343 | 54,137 | 0.930 |
| gin | Go | 155,243 | 38,829 | 43,944 | 0.884 |
| gson | Java | 419,051 | 104,783 | 92,636 | 1.131 |
| ripgrep | Rust | 915,147 | 228,809 | 222,109 | 1.030 |
| dsh-code-graph | TypeScript | 309,191 | 77,316 | 78,598 | 0.984 |
| **overall** | 300 files | **2,188,908** | **547,336** | **539,157** | **1.015** |

- In aggregate the estimate is within **+1.5%**.
- Per language it is not: Go over-counted at 0.884, Java under-counted at 1.131 — a spread of ~±13%.
- A cross-language aggregate is safe; a single-language figure deserves `--verify`.
- **Not model-accurate.** This plugin targets DeepSeek Harness models; `cl100k_base` is OpenAI's. A close ratio says `chars / 4` is a sane shortcut for source code, not that these counts are what a DeepSeek model would bill.

</details>

---

## What this does not show

- **Not an accuracy measurement.** Every number is about cost. Nothing here establishes that the graph's answer is as *useful* as three files of source — and with 56% truncated at the default budget, there is specific reason to ask. A retrieval-quality benchmark is the obvious missing companion.
- **Six repositories**, all well-known open-source libraries. A large application monorepo, generated code, or a polyglot repository could behave differently.
- **Five questions per repository**, hand-written — chosen to be realistic, but chosen by the same person who wrote the plugin.
- **The grep baseline is a model, not a real agent.** A capable agent might grep more cleverly or stop early; it might equally read ten files instead of three. The model is fixed and documented so it can be argued with.
- **Latency figures are machine-specific** and are the only non-deterministic numbers in the run.

Two documentation defects surfaced during this work and are recorded rather than quietly fixed:

- The `max_tokens` description promises every result reports the budget it ran under. Only `code_find` does.
- `Design.md` claims a 2,000-token default for `code_impact`. `clampBudget` has no per-tool default.

## Method

- Each question is asked twice: once of an agent with no graph (grep the indexed files, rank by match count, read the top 3 in full), once of an agent with the graph (one tool call).
- The grep baseline is given every cheap advantage: 3 files not 10, only files the index also covers, and search terms that drop question-framing verbs like "defined" and "calls" — modelling an agent that greps for the identifier, not the sentence. Leaving those in would have inflated the baseline.
- Errored calls stay in the CSV with `status=error` and are **excluded from every aggregate**, carrying no token columns rather than zeros. This run produced none; the rule is enforced by a regression test, because a failed call recorded as zero tokens is how a benchmark starts reporting failures as wins.

### Pinned references

| Repository | Tag | Commit |
|---|---|---|
| [expressjs/express](https://github.com/expressjs/express) | v5.2.1 | `dbac741a49a5` |
| [honojs/hono](https://github.com/honojs/hono) | v4.13.5 | `06880c4a2b04` |
| [gin-gonic/gin](https://github.com/gin-gonic/gin) | v1.10.1 | `b5af7796535d` |
| [google/gson](https://github.com/google/gson) | gson-parent-2.14.0 | `3ff35d626989` |
| [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | 14.1.1 | `4649aa970061` |
| dsh-code-graph | — | `7443f0dab41f` |

express and gin are shared with the [`code-review-graph`](https://github.com/tirth8205/code-review-graph)
benchmark set — the project this plugin was inspired by — so the two can be compared.

## Reproducing

```sh
git clone https://github.com/simomat/dsh-code-graph.git
cd dsh-code-graph
pnpm install
pnpm run bench -- --calibrate
```

- Requires Node 26.7.0 (pinned in `.tool-versions`) and `git`.
- **~7 seconds** with a warm clone cache. The first run also clones five repositories (~75 MB), which dominates and is network-bound.
- Two consecutive runs produce byte-identical CSVs apart from run id, date and elapsed times.
- Full clones at pinned commits, verified after checkout — a mismatch **aborts the run** rather than silently measuring the wrong tree.
- The index is rebuilt from scratch every run.

Narrow a run:

```sh
pnpm run bench -- --scenario agent-baseline --repo express
pnpm run bench -- --verify     # recount with a real tokenizer
```

---

*Generated from [`bench/results/`](results/). Harness, method and troubleshooting: [`bench/README.md`](README.md).*
