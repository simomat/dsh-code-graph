# Security policy

## Supported versions

`main` only. This is not yet published to a registry — install is from source — so a fix ships as a
commit and there are no back-ported branches.

## Reporting a vulnerability

Report privately through GitHub's **[private vulnerability
reporting](https://github.com/simomat/dsh-code-graph/security/advisories/new)** rather than opening
an issue. Include what you did, what happened, and the repository shape that triggered it if it is
input-dependent.

Expect an acknowledgement within a week. If you get no reply, open a plain issue saying only that
you sent an advisory — no details — so it does not go unseen.

## Scope

`dsh-code-graph` runs in-process inside the harness and offline: tree-sitter parses as WASM, storage
is the built-in `node:sqlite`, and `git` is only ever asked to enumerate files. It opens no network
connections and executes none of the code it indexes.

The realistic threat surface is therefore **the repository being indexed**, which is untrusted
input:

- File contents reaching the parsers, and the paths, identifiers and signatures extracted from them
  that then flow into SQL, into FTS queries, and into tool results the agent reads.
- Path handling during file enumeration — anything that would let an indexed repository cause a read
  or a write outside its own tree, or outside the index directory (`indexDir`, which is deliberately
  not inside the repository).
- Resource exhaustion that a crafted repository can trigger past the existing guards
  (`maxFileBytes`, the token budgets, the exclusion list).

Findings in those areas are in scope. So is anything that lets a tool result carry content able to
escape its result shape.

Out of scope: the harness itself (report to
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)), the tree-sitter grammars
upstream, and the general observation that an agent reading a malicious repository may read
misleading text — that is what indexing a repository means.
