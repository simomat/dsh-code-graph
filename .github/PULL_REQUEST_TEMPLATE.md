## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm test` passes (oxlint, then the suite)
- [ ] `pnpm run typecheck` passes (both the server and client configs)
- [ ] `pnpm run build` passes, if anything under `src/client/` or `tsdown.config.ts` changed
- [ ] Tests added or updated, under the matching `tests/<subsystem>/` directory
- [ ] `Design.md` updated, if the database schema, an edge kind, or a tool's result shape changed
- [ ] `README.md` updated, if a setting or an install step changed
