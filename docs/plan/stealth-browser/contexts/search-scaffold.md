# search-scaffold — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** core-scaffold, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-scaffold`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

`@adhd/stealth-search` exists as a generator-built entrypoint with the sibling structure, an ADR-0003 manifest with both bins and EVERY dependency the later search states need, the workspace alias and lockfile importer, and a typecheck-spec baseline, so no later search state touches package.json, project.json or the lockfile.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/` with the entrypoint generator output; MODIFY `tsconfig.base.json` (alias), `pnpm-lock.yaml` (the importer block only), `docs/plan/stealth-browser/evidence/split/` (`search-dry-run.txt`, `search-deps.md`); CREATE `tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json`.

- **Reference Pattern:** `entrypoint/dispatch-cli` and `entrypoint/backlog` (structure, targets, tags); `PLAN:evidence/scaffold-dry-run.txt` and `evidence/tripwire/scaffold-dry-run.txt` (transcript shape); `SPEC-stealth-search.md` section 1.1 and 1.2 (ref `[ref:stealth-search-spec]`).

- **Delta Spec:** (1) Run the generator in dry-run mode first and save the transcript: `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-search --nxLayer entrypoints --platform node --dry-run` -> `evidence/split/search-dry-run.txt`; then the real run. Pass bare names, never the package name. (2) Generator side effects (tripwire-scaffold precedent): `git restore nx.json eslint.config.mjs` when the generator touched them; commit the generated typecheck-spec baseline; rename an emitted `vite.config.mts` to `.ts`; keep the `.git`-tracked top-level set equal to the siblings. (3) Manifest: name `@adhd/stealth-search`, `0.1.0`, `bin` {`stealth-search`: `./dist/bin/cli.js`, `stealth-search-mcp`: `./dist/bin/mcp.js`}, `main`/`types`, no `module`/`exports`, `engines.node >=22.5`, publish metadata like the siblings. RESOLVE at dispatch: the exact apigen package set and ranges by reading `entrypoint/backlog/package.json`; the extra imports of the source repo's search files (`rg "from '" /Users/nix/dev/ai/scratch/agent-browser/search*.ts fetch-*.ts network-capture.ts cdp-search.ts`) — every non-builtin package is either declared or listed as intentionally unused in `evidence/split/search-deps.md`. (4) Dependencies to declare now (workspace packages by version range that resolves in the workspace, never `link:`/`file:`): the core, the tripwire package, `@adhd/sox-telemetry`, apigen core-client/engine-naming/engine-runtime/plugin-mcp/plugin-cli-output/plugin-ir-cache/plugin-tracing, `@modelcontextprotocol/sdk`, `commander`, `turndown`, `pdfjs-dist`. `turndown`, `pdfjs-dist` and `commander` need no approval (user decision). (5) Add the `@adhd/stealth-search` alias to `tsconfig.base.json`, run `pnpm install` in the worktree, confirm the lock diff is only the new importer plus resolved new packages (no removed lines), and run `lint`, `typecheck`, `build` on the empty shell.

- **Invariants:** [inv:one-new-package] (the third package, `APPROVAL-split.md`) [inv:pnpm-only] [inv:node-modules] [inv:greenfield] [inv:search-over-core]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-scaffold]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-scaffold` — runs every acceptance criterion below (red until the work is done); `--only search-scaffold.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-scaffold --only search-scaffold.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-scaffold.1] The package is generator-built: evidence/split/search-dry-run.txt holds the transcript of `npx nx g @adhd/workspace-codegen-nx:entrypoint --name stealth-search --nxLayer entrypoints --platform node --dry-run` with its CREATE list, entrypoint/stealth-search/project.json is named `stealth-search`, and its tags are exactly domain:entrypoint, pkg-kind:entrypoint, pkg-class:entrypoint, layer:entrypoints, platform:node and access:domain (plus any `publish:npm` or `scope:*` tag).
- [search-scaffold.2] Structure equals the sibling entrypoints: the tracked top-level file set contains every file common to dispatch-cli, backlog and apigen-cli (minus BACKLOG.md, CONTRIBUTING.md and the dropped e2e lane), and `nx show project stealth-search` lists every target common to dispatch-cli and backlog plus `build-bin`, minus the dropped `e2e` target (the user replaced the live-Chrome e2e lane with unit tests that simulate the real use cases).
- [search-scaffold.3] The manifest is the ADR-0003 CJS-only entrypoint shape: name @adhd/stealth-search, version 0.1.0, bins `stealth-search` -> ./dist/bin/cli.js and `stealth-search-mcp` -> ./dist/bin/mcp.js, `main` and `types`, no `module`, no `exports`, engines.node >= 22.5, repository.directory entrypoint/stealth-search, and no `link:` or `file:` dependency specifier anywhere.
- [search-scaffold.4] The manifest declares EVERY dependency the later search states need so none of them edits package.json or the lockfile: @adhd/stealth-core-browser, @adhd/resilience-core-tripwire, @adhd/sox-telemetry, the apigen core-client / engine-naming / engine-runtime / plugin-mcp / plugin-cli-output / plugin-ir-cache / plugin-tracing packages, @modelcontextprotocol/sdk, commander, turndown and pdfjs-dist (workspace packages as ranges that resolve in the workspace, never link: or file:), and every `import` of a bare package in the source repo's search files that is not a node builtin is covered or recorded as unused in evidence/split/search-deps.md. A declared dependency the port later proved unused (and nothing imports) may be absent when evidence/split/search-deps.md records `DROPPED-UNUSED: <name>` (`@adhd/apigen-plugin-ir-cache`, dropped by search-hosts).
- [search-scaffold.5] Workspace wiring is minimal: tsconfig.base.json maps `@adhd/stealth-search` to a path under entrypoint/stealth-search and keeps the `@adhd/stealth-core-browser` alias, `pnpm-lock.yaml` has an `entrypoint/stealth-search:` importer, no [psm:search-scaffold] commit removes a pnpm-lock.yaml line, and tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json exists.
- [search-scaffold.6] The empty shell passes its gates: `nx run stealth-search:lint`, `:typecheck` and `:build` exit 0.
- [search-scaffold.7] Only owned paths changed by [psm:search-scaffold] commits.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/", "tsconfig.base.json", "pnpm-lock.yaml", "tools/nx-plugins/build/executors/typecheck-spec/stealth-search.baseline.json", "docs/plan/stealth-browser/evidence/split/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-search/` shell, alias, importer, baseline, `evidence/split/search-dry-run.txt`, `evidence/split/search-deps.md`. Modified: `tsconfig.base.json`, `pnpm-lock.yaml`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-scaffold]`:

- [ ] After the generator run and manifest: `feat(stealth-search): generate the entrypoint shell and manifest [psm:search-scaffold]`
- [ ] After install and gates: `build(stealth-search): wire alias and importer [psm:search-scaffold]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.
