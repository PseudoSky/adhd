# Shared context — Migrate the agent-search chrome runner to @adhd/stealth-browser (entrypoint)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Glossary

- **[def:runner]** — the generic Chrome/CDP runner at `/Users/nix/dev/ai/scratch/agent-browser/adhd/` (CDP session, targets, launch, settle, capture, parsers, storage readers, domain wrappers, ChromeManager) plus the engine-agnostic queries `search/queries/{activity,context}.ts`. This is "the correct package" being migrated.
- **[def:src]** — `/Users/nix/dev/ai/scratch/agent-browser`, the scratch repo's agent-browser project (agent-search). Local-only git repo; read-only for every state except `agent-search-cutover`.
- **[def:wt]** — `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`, the single shared worktree (branch `stealth-browser`, cut from main c6011647). Every executor works here, in the same directory, on the same branch.
- **[def:pkg]** — `entrypoint/stealth-browser`, the ONE approved new package, `@adhd/stealth-browser`, created by the workspace generator.
- **[def:bucket]** — a migration/test state's owned write scope. Buckets are directory-disjoint; `scripts/ownership.json` is the single source and `scripts/check-disjoint.py` proves concurrent states never overlap.
- **[def:psm-tag]** — every commit message ends `[psm:<state-slug>]`. The guard's ownership check reads these tags and fails if a tagged commit touches a path outside the state's owned set.
- **[def:ticket]** — backlog plan item `8468f7b1-8adc-4237-9986-21ea1e27c537` (adhd, in_progress). Tests cite its first 8 characters `8468f7b1` plus a `[<state>.N]` criterion id.
- **[def:verbs]** — the six chrome-runner verbs: `chromeStatus`, `launchChrome`, `shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext`.
- **[def:surfaces]** — library (`src/index.ts`), CLI (`stealth-browser`), MCP stdio server (`stealth-browser-mcp`).

## Cross-cutting invariants

- **[inv:one-new-package]** — the human approved creating exactly ONE new package, `entrypoint/stealth-browser`, in the verbatim request. No second project.json may be added; the former nested `@adhd/cdp-connection` package does NOT travel (it becomes `src/lib/cdp/`). Guarded by `scaffold.5`.
- **[inv:shared-worktree]** — all executors work in the same worktree and branch. Stage only your own explicit paths (`git add <path>`); never `git add -A`/`.`/`commit -a`, `git stash`, `git reset --hard` or `git clean`. Never revert another state's changes.
- **[inv:owned-paths-only]** — a state writes only its `mutates` set (= `scripts/ownership.json` entry). Plan bookkeeping (`state.json`, `events.ndjson`, `docs/plan/plan-index.json`) is exempt.
- **[inv:source-untouched]** — `/Users/nix/dev/ai/scratch/agent-browser/adhd/` and every agent-search file stay byte-identical until `agent-search-cutover` (baseline hash in `evidence/source-baseline.txt`; guard `source_untouched`). The live MCP source keeps working throughout.
- **[inv:no-main-writes]** — never write to `/Users/nix/dev/node/adhd` (the main checkout) except the dispatcher's ff-only merge. Its `node_modules/.modules.yaml` mtime is stamped and re-checked.
- **[inv:node-modules]** — `scaffold` symlinks the main checkout's node_modules (read-only, generator/nx only); `deps-install` replaces it with a real worktree install before any `pnpm add`. Never install through the symlink.
- **[inv:worktree-required]** — monorepo (nx.json, pnpm-workspace.yaml present): every executor works in the git worktree above, never the main checkout; a worktree that needs node_modules symlinks the main one, it does not reinstall (exception: `deps-install`, which must change the lockfile and therefore owns a real install).
- **[inv:pnpm-only]** — pnpm@8.15.9 with the machine-wide store (`~/Library/pnpm/store`); never npm/yarn.
- **[inv:esm-js-specifiers]** — relative imports use `.js` specifiers (sibling convention); the source's `.ts` specifiers are rewritten during the port. No committed compiled `.js` twins.
- **[inv:stealth]** — Chrome is launched with `--remote-debugging-port` and WITHOUT `--enable-automation`; no `Runtime.evaluate` anywhere (DOM walks only). Behavior-preserving port: these are the runner's reason to exist.
- **[inv:live-chrome]** — the developer's live Chrome on port 9222 is sanctified: no test, guard or script may `pkill`/`killall`/`lsof`-kill it or connect to 9222. Unit tests mock process spawn; e2e uses a dedicated free port, a temp user-data-dir and a fake HOME, and kills only the PID it launched.
- **[inv:trace-namespace]** — apigen tracing uses `makeTracingPlugin({ serviceName: 'adhd' })` configured once in `src/tracing.ts`, mounted in every `usePlugins` array; the package's own `tracingPlugin` singleton (namespace `apigen`) is never imported. Records are `adhd.<op>.start|finish|error`.
- **[inv:unit-purity]** — the unit lane (`*.spec.ts`) has no subprocess, no network, no real Chrome, no real profile: `child_process`, WebSocket/`fetch` and fs touch points are mocked.
- **[inv:tests-cite]** — every spec/e2e file cites the ticket `8468f7b1` and at least one valid `[<state>.N]` criterion id.
- **[inv:e2e-shape]** — one e2e run drives all three surfaces with ONE `beforeAll` and ONE `afterAll`, real Chrome, no mocks, files named `*.e2e.test.ts`, minimum duration 5 s.
- **[inv:blind-review]** — the reviewer receives the diff and the single word `Review`: no context, rationale, review points or prior state.
- **[inv:scratch-local-only]** — the scratch repo is local-only: never push; no PII in commits; stage explicit paths because its working tree carries other projects' uncommitted edits.
- **[inv:no-ai-attribution]** — no AI-disclosure lines in commits, docs or README.

## Reference patterns

- **[ref:backlog-tracing]** — `entrypoint/backlog/src/tracing.ts`: `export const tracingPlugin = makeTracingPlugin({ serviceName: 'adhd' });` configured once, imported by the MCP and CLI hosts, never the package singleton. Conformance rule: guard checks `tracing-plugin.1,2,3,5` ([audit-final.ref-backlog-tracing]).
- **[ref:entrypoint-structure]** — `entrypoint/dispatch-cli` (+ backlog, apigen-cli): the common top-level files, tags, package metadata, nx targets (`build-bin`, `verify-dist-load`, `e2e`), `src/{api,index}.ts`, `src/lib/`, `src/test/`, `bin/cli.ts`. Conformance rule: guard `entrypoint-parity.1-4` ([audit-final.ref-entrypoint-structure]).
- **[ref:apigen-host]** — `entrypoint/backlog/src/{api,server,cli}.ts`: an apigen module (`api.ts` async verbs) projected to an MCP host and a CLI host through plugins. Conformance rule: `surface-hosts.1-2` plus tracing mounts ([audit-final.ref-apigen-host]).
- **[ref:runner-port]** — `/Users/nix/dev/ai/scratch/agent-browser/adhd/`: the behavior-preserving port. Conformance rule: every manifest file keeps every export, stays >= 80% line-similar after `.ts`->`.js` normalization, keeps its must-contain tokens ([audit-final.ref-runner-port]).
