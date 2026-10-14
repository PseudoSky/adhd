# Plan: policy-core — `@adhd/policy-core-client`, `adhd-policy`, `@adhd/apigen-plugin-policy`

Branch: `feat/policy-core` (worktree `.worktrees/policy-core`). Not merged to `main`; no push.
Normative inputs (copied under `spec/`): `architect-spec*.md` (behaviors, IDs like `CL-02`), `architect-interfaces*.md` (shapes), `demo-policy-v1.md` (the demo; scenarios S1-S7), `research-auth-mechanisms.md` (context only).
Decisions register: `SOURCE-MODEL-GAP-ANALYSIS.md` §9 (O-1 to O-14), `TAXONOMY-CONFORMING-DESIGNS.md` §10 (BA-1 to BA-11, E1 to E8), `INTERFACES.md` §2 (D-24 to D-26).
Companions in this directory: `INTERFACES.md` (contracts and decisions), `DOD.md` (definition of done), `APPROVAL.md`, `tickets/T*.md` (scope plus Gherkin acceptance).

## Goal
A host-agnostic authorization library (Hasura-style declarative permissions evaluated with `@adhd/data-query-engine`; global→project→local layers; allow/ask/deny; `grant`/`only` narrowing; optional flat attribute bag), an apigen-projected CLI/MCP/HTTP surface, `run`/`serve`/`mcp-json` verbs over apigen sources, and an apigen Layer plugin so `--use @adhd/apigen-plugin-policy` gates any served operation set.

## Scope (built now) / not built now
Built: library, operation set, three entry files, `createDecider`, Layer plugin, apigen `bin:` source (argv fallback and stdio-MCP serving only), `run`, `serve`, `mcp-json`, docs.
Not built (filed or already tracked): `remote:` sources (backlog f6bf8550), sandbox (separate package, own approval), agent-mcp integration, auth layer, `residual` query (OD-21), apigen approval-required result (backlog 7e7eb01d). Subprocess/real-server (e2e lane) proofs are written only if cheap and in-process; they are NOT run (owner: no e2e).

## Execution rules (owner direction, this session)
1. Only the `performance` agent implements and reviews; the `product` agent wrote the demo and writes the Gherkin acceptance. No other agent types.
2. Front-load all `src` authoring (Phase A). Code review in large batches at package completion (Phase B). Tests authored last (Phase C): functional tests derived only from the demo's user usage examples, in the unit `test` lane (no subprocess, no e2e).
3. Never merge to `main`; never push. Commit by explicit pathspec on `feat/policy-core` only.
4. Gates per phase end: `npx nx affected -t lint,typecheck,typecheck-spec`; Phase C adds `npx nx affected -t test` (never `e2e`). Final message lists every gate and exit code.
5. Every deferral/bug found is filed through `backlog-operator` at discovery.

## Phases and tickets (dependency order)
| Phase | Ticket | Deliverable | Depends on |
|---|---|---|---|
| A | T01 | Domain `policy` in `.adhd/workspace.json`; scaffold `policy-core-client`, `entrypoint/policy`, `apigen-plugin-policy` via generators (dry-run first) | APPROVAL.md |
| A | T02 | `spec`: types + `policy.schema.json` + `compiled.schema.json` | T01 |
| A | T03 | `core`: engine adapter, canonicalize/hash, `compile`, `loadCompiled`, memo | T02 |
| A | T04 | `core`: `evaluate`, `resolve`, `explain`, `narrow` | T03 |
| A | T05 | `service`: `api.ts` operations, ctx/ports, layer loading + YAML, `verify`, `show`, `doctor`, `draft`, `createDecider`; root export | T04 |
| A | T06 | Entry files cli/mcp/http, bins, baked IR, `adhd-policy` wiring | T05 |
| A | T07 | `apigen-plugin-policy` Layer package | T01 (no import edge to policy) |
| A | T08 | apigen `bin:` source (discovery first, OD-32 resolved by the discovery report) | T01 |
| A | T09 | Wrapper verbs `run`, `serve`, `mcp-json` + attribute sources | T06, T07, T08 |
| A | T10 | READMEs, AGENTS.md, usage docs, CHANGELOGs | T05-T09 |
| B | R1-R4 | Large-batch reviews: R1 client (after T05), R2 entrypoint (after T06+T09), R3 Layer (after T07), R4 apigen bin (after T08); fixes folded back | A |
| C | T11-T17 | Functional tests, one ticket per demo scenario S1-S7 | B |
| C | T19 | Safety-relevant failure-path tests (Layer fails closed, serve handshake failure, attribute precedence) | Phase B |
| C | T18 | Reconcile `demo-policy-v1.md` UNKNOWNs against the built CLI; final gates | T11-T17 |

Parallelism: after T01, T02→T05 (chain), T07, T08 run in parallel. T06/T09 follow their inputs.

## Risks tracked
- apigen schema extraction of `Record<string, unknown>` and unions (IF-12): checked in T06 against the real extractor; if lossy, the operation inputs take JSON strings for those fields and the limitation is filed.
- `UsePlugin`/envelope shape (LI-01): T07 confirms against `package-invoker.ts` before coding.
- Query engine single-row evaluation (IF-01): T03 first step.
- `bin:` source needs apigen internals (OD-32): T08 starts with a read-only discovery that names the host package and extractor seam; if no seam exists the ticket stops and reports (no stopgap shell).
