<!-- markdownlint-disable MD013 MD033 -->
<!-- gap-check-mode: strict -->
# apigen-client-generation — Implementation Plan

> **Goal:** Build the `@adhd/apigen-*` system — a TypeScript-to-API code-generation tool that takes any `.ts` file and exposes its exports as MCP tools, HTTP APIs, or CLIs without modifying source code.
>
> **Spec:** `~/dev/projects/reverse-apis/docs/plans/client-generation/AGENT_PROMPT.md`
> **Executor:** `sox-active:backend-developer`
> **Author:** planner (api-designer)
> **Created:** 2026-06-20

---

## Consumer

TypeScript developers who want to expose existing functions as an API surface (MCP server, HTTP
API, CLI) without decorating or restructuring their source code.

```typescript
// Source — unchanged, no API awareness
export async function getUser(ctx: DbContext, userId: string): Promise<User> { ... }
export async function sendEmail(to: string, subject: string, body: string): Promise<void> { ... }
```

```bash
# One command → running MCP server
npx @adhd/apigen-cli run --source ./api.ts --type mcp
```

## Value-delta

| Before | After |
|--------|-------|
| Write MCP/HTTP/CLI wiring by hand per project | One `--type` flag, zero source changes |
| Restart when adding a function | Re-run the same command |
| Hand-craft JSON schemas | Generated from TypeScript types via ts-morph |
| Per-project server boilerplate | Generate once, then `node dist/server.js` |

---

## What this directory is

A **resumable state machine**. The implementation is decomposed into 23 states (work + audit + human gate).
Each state is a self-contained work order keyed by an immutable **slug**.

```text
docs/plan/apigen-client-generation/
├── README.md           ← this file
├── dag.json            ← STRUCTURE: nodes (slug → phase, depends_on, guard, artifacts)
├── state.json          ← RUNTIME: current_state, per-slug status, logs
├── state-machine.md    ← human render of dag.json
├── references.json     ← reference pattern catalog
├── interfaces.json     ← external interface contracts (ts-morph, MCP SDK, etc.)
├── scripts/
│   ├── audit_apigen.py ← phase-scoped audit runner
│   ├── gap-check.js    ← deterministic gap checker
│   └── env-pin-check.js← guard env-pinning lint
└── contexts/
    ├── _shared.md      ← centralized types, invariants, shapes
    └── <slug>.md       ← one work order per state
```

---

## Value delta

Before → after, framed as a consumer-observable change. (Canonical heading required by the gate; the legacy `## Value-delta` table above is kept as a quick-reference.)

| Consumer observable | Before | After |
|---|---|---|
| Expose a `.ts` file's functions as MCP tools | Hand-write a Server, register each tool, wire stdio transport (~150 LOC/project) | `npx @adhd/apigen-cli run --source api.ts --type mcp` — `tools/list` returns every export, zero source edits |
| Get an HTTP API for the same functions | Re-implement routes per framework | `--type api-fastify` or `--type api-express`, identical `POST /<id>/<fn>` shape |
| Get a CLI for the same functions | Hand-roll a Commander program per project | `--type cli-output` emits `cli.ts` — one subcommand per export, runnable immediately |
| Ship a generated server to disk | Copy boilerplate, maintain by hand | `generate … --out-dir ./out && node out/server.ts` — byte-identical behavior to `run` |
| Add a new function | Edit server wiring, restart | Re-run the same command |
| Compose a multi-package surface | Manual server aggregation | `run-registry --tag api` discovers + wires by package tag |

## Definition of Done

> **Behavioral clauses are proven by `scripts/probe_mcp.mjs`, which DERIVES every expected observable from the fixture at runtime (no hard-coded values — see `[conv:fixture-samples]`).** Each behavioral clause names its `delivered-by:` work states and a `negative-control:` that MUST turn the clause red if the bug is reintroduced.

- `[dod.1]` A user runs the CLI with a TypeScript source file and gets a working MCP stdio server — `generate` + `run` commands work end-to-end.
  - entrypoint: `npx tsx packages/apigen/cli/src/index.ts run --source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp`
  - observable: MCP `tools/list` equals the fixture's exported function names (derived in-process); `callTool(fn,{data:<sample>})` deep-equals the value of calling that export directly in-process; process exits 0 when transport closes. The same invariants hold over the `sse` and `streaming-http` transports.
  - delivered-by: cli-run-cmd, plugin-mcp, runtime-dispatch, schema-extraction, runtime-middleware, integration-tests-v2
  - negative-control: rename a fixture export (e.g. `getUser`→`getUserX`) → the derived tool set changes → `tools/list` no longer matches → this clause (dod.1, and dod.1-sse / dod.1-streaming-http) goes red.

- `[dod.2]` Running `generate` writes files to disk that run as an equivalent MCP server.
  - entrypoint: `npx tsx packages/apigen/cli/src/index.ts generate --source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp --out-dir /tmp/apigen-test-out && npx tsx /tmp/apigen-test-out/server.ts`
  - observable: Generated `server.ts` starts; both the run-mode server and the generated server deep-equal the SAME derived ground truth (hence each other) for `tools/list` and every `callTool`.
  - delivered-by: cli-generate-cmd, plugin-mcp, schema-extraction, schema-composition, integration-tests-v2
  - negative-control: corrupt the generated `server.ts` template so one tool is dropped → the generated server's `tools/list` no longer deep-equals the run-mode/derived ground truth → this clause (dod.2) goes red.

- `[dod.3]` The `ctx` convention is enforced: first param named `ctx` is excluded from schema. [structural]
  - Proven by: `integration/schema.spec.ts` — `generateSchemas()` on `real-api.ts` (which has `ctx: unknown` on `getUser` and `listUsers`) produces schemas where `ctx` is absent from every function's params. Teeth-guarded by `audit-final.schema-teeth` (the spec MUST contain `not.toContain('ctx')`).
  - delivered-by: core-types, schema-extraction, integration-tests-v2
  - negative-control: remove the `getName()==='ctx'` filter → `ctx` appears in params → schema spec assertion fails → this clause (dod.3) goes red.

- `[dod.4]` Session middleware adds envelope field; `false` override suppresses it. [structural]
  - Proven by: `integration/schema.spec.ts` — `createApiPackage()` with `sessionMw` + `overrides:{ping:{session:false}}`; `getUser.input.required` contains `session`; `ping.input.properties` has no `session`. Teeth-guarded by `audit-final.schema-teeth`.
  - delivered-by: schema-composition, runtime-middleware, integration-tests-v2
  - negative-control: ignore the `false` override → `session` reappears in `ping` → spec assertion fails → this clause (dod.4) goes red.

- `[dod.5]` `run-registry` discovers packages by tag and wires a multi-package MCP server.
  - entrypoint: `npx tsx packages/apigen/cli/src/index.ts run-registry --packages-dir packages/apigen/cli/src/test/fixtures/registry --tag api --type mcp`
  - observable: `tools/list` equals the union of exports from the `api`-tagged packages (derived from each package); untagged exports (e.g. `internal` from `pkg-c`) are absent; each `callTool` deep-equals the originating package's in-process ground truth (so `hello`→`'a'`, routed to pkg-a not pkg-b).
  - delivered-by: cli-run-cmd, cli-generate-cmd, integration-tests-v2
  - negative-control: remove the `internal` tag filter in run-registry → `internal` appears in `tools/list` → the `internal`-absent assertion goes red → this clause (dod.5) goes red.

- `[dod.cli]` `--type cli-output` emits a runnable CLI whose subcommands return the same values as the source functions.
  - entrypoint: `npx tsx packages/apigen/cli/src/index.ts generate --source packages/apigen/cli/src/test/fixtures/real-api.ts --type cli-output --out-dir /tmp/apigen-cli-out && npx tsx /tmp/apigen-cli-out/cli.ts getUser --user-id abc`
  - observable: For every fixture export, running the generated subcommand as a real subprocess prints JSON to stdout that deep-equals the value of calling that export directly in-process (derived).
  - delivered-by: plugin-cli-output, cli-generate-cmd, integration-tests-v2
  - negative-control: drop a subcommand from the generated `cli.ts` produced by `generate --source packages/apigen/cli/src/test/fixtures/real-api.ts --type cli-output` → that subcommand errors → its stdout no longer deep-equals the derived ground truth → this clause (dod.cli) goes red.

- `[dod.6]` All 9 packages build cleanly. [structural]
  - Proven by: `npx --yes nx run-many --target=build --projects=apigen-core,apigen-runtime,apigen-plugin-mcp,apigen-plugin-jsonschema,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output,apigen-nx,apigen-cli` exits 0.
  - delivered-by: scaffold-packages, scaffold-plugins, plugin-jsonschema, plugin-api-fastify, plugin-api-express, plugin-cli-output, nx-generator

- `[dod.7]` The `@adhd/apigen-nx:generate` executor runs as an Nx cache-aware target.
  - entrypoint: `npx --yes nx run apigen-cli:generate-api` (run twice)
  - observable: Run 1 writes files to the configured outDir; run 2 reports an Nx cache hit (`local cache` / `read the output from the cache`) and produces byte-identical files; whole pipeline exits 0.
  - delivered-by: nx-generator, cli-generate-cmd
  - negative-control: disable nx target caching (remove the executor's `cache`/`outputs` config) → run 2 omits the cache-hit marker → the run-2 cache-hit assertion goes red → this clause (dod.7) goes red.

- `[dod.8]` `nx g @adhd/apigen-nx:plugin` scaffolds a buildable OutputPlugin package.
  - entrypoint: `npx --yes nx g @adhd/apigen-nx:plugin test-plugin --directory packages/apigen/plugins/test-plugin --no-interactive && npx --yes nx build apigen-plugin-test-plugin`
  - observable: Directory created with correct project.json, package.json, TypeScript boilerplate that implements `OutputPlugin`; build exits 0.
  - delivered-by: nx-generator, scaffold-plugins

- `[dod.9]` **Code-first round-trip closes F28/F29: every export shape projects by exported symbol (behavioral)** — Code-first round-trip closes F28/F29: every export shape projects by exported symbol.
  - given: source files exercising all six export shapes
  - when: adhd-apigen extracts + projects them
  - then: ids/routes/tool-names match the exported symbols
  - entrypoint: `packages/apigen/cli/src/test/integration/export-shape-matrix.spec.ts`
  - observable: `For named / renamed (export {x as y}) / default-fn / default-object / anonymous-default / CJS sources, the derived descriptor ids + per-transport projections (HTTP/MCP/CLI) deep-equal the EXPORTED-symbol names — never the declaration name`
  - negative-control: `Revert the extractor to name by declaration symbol -> renamed/default/CJS rows no longer match exported names -> this clause goes red`
  - delivered-by: `ts-extractor-by-symbol, naming-helpers, audit-v2-core, integration-tests-v2`
- `[dod.10]` **Central validation Layer rejects invalid input before dispatch (behavioral)** — Central validation Layer rejects invalid input before dispatch.
  - given: an operation with a typed input schema
  - when: invoke is called with schema-violating data
  - then: an invalid_argument ApiError is returned and the fn is not invoked
  - entrypoint: `packages/apigen/cli/src/test/integration/canonical.spec.ts`
  - observable: `invoke() with data violating input schema throws ApiError{code:'invalid_argument'} and the target function is NEVER called; valid data passes through and returns ground truth`
  - negative-control: `Remove the validation Layer from the harness -> bad data reaches the function -> the invalid_argument assertion goes red`
  - delivered-by: `central-validation, layer-harness, audit-v2-harness, integration-tests-v2`
- `[dod.11]` **Request envelope is sourced from transport metadata, not the body (behavioral)** — Request envelope is sourced from transport metadata, not the body.
  - given: a layer/envelope plugin declaring an envelope field
  - when: the field arrives via metadata vs body
  - then: only the metadata-sourced value reaches the envelope
  - entrypoint: `packages/apigen/cli/src/test/integration/canonical.spec.ts`
  - observable: `An HTTP request carrying x-adhd-<field>/x-<plugin-id>-<field> headers populates the operation envelope; the same field placed only in the JSON body does NOT populate the envelope`
  - negative-control: `Bind the envelope from the body instead of metadata -> the header-sourced assertion goes red`
  - delivered-by: `projection-transports, layer-harness, audit-v2-projection, integration-tests-v2`
---

## Execution model

- **Parallel execution:** Yes — see `dag.json` for explicit parallel groups: schema extraction/composition/nx-generator in foundation (3-way); runtime dispatch/middleware (2-way); 4 remaining plugins after checkpoint (4-way); cli-generate-cmd/cli-run-cmd in CLI (2-way).
- **Implementer:** `sox-active:backend-developer` (one agent per state, stop at boundary).
- **Review:** `sox-active:code-reviewer` reviews after `audit-plugins` before CLI states begin. Reviewer gate is encoded in `audit-plugins` context.
- **Automatic dispatch:** No — print Dispatch line and stop. The executor reads `state.json` to find `current_state` and resumes from there.

---

## Plan-level invariants

1. **Platform:node for all `packages/apigen/` packages.** None of the apigen packages run in a browser. Tags: `layer:logic,platform:node` for plugins; `layer:logic,platform:shared` for core and runtime (pure TS, no Node-only APIs used directly).
2. **`--type` is the canonical plugin-selector flag.** The old `--output` flag is NOT implemented anywhere in this plan.
3. **`PluginOutput.files` is language-agnostic.** Plugins emit `{ path: string; content: string }[]` — no assumption about file language. Python gRPC plugins can emit `.py` files by implementing `OutputPlugin`.
4. **`dispatch()` is the single canonical dispatch path.** No plugin may inline dispatch logic. All plugins import from `@adhd/apigen-runtime`.
5. **`ctx` is excluded by name only.** `p.getName() === 'ctx'` — no type checking.
6. **`data: {}` wrapper is always present in composed schemas.** Even for zero-param functions. Always `required`.

---

## Status

Run from repo root:

```bash
node docs/plan/apigen-client-generation/scripts/gap-check.js docs/plan/apigen-client-generation
# and
cat docs/plan/apigen-client-generation/state.json | python3 -c "import json,sys; s=json.load(sys.stdin); print('current:', s['current_state'])"
```
