# UNRESOLVED — Backlog Interface v2 Target-State Demo

Interfaces this demo had to guess, and scope gaps found while authoring. Resolve each
before treating the corresponding DEMO.md step as authoritative. Do **not** resolve these
in this file — they are logged here for the implementer and the spec owners.

## Unresolved interfaces

| ID | Guessed interface | Used in | Basis | What would confirm it |
|---|---|---|---|---|
| U1 | Project-level cross-repo traversal: `backlog query --view graph --filter '{"repo":"sox-ecosystem"}' --group-by project` returning `data.projects` | §2.3 (AC-8 second half) | AC-8 names the capability ("EPIC-A `aggregateBy`/project traversal") but no invocation or output shape is pinned | EPIC-A spec / dimensional.ts aggregateBy project traversal; confirm the view composition and result shape |
| U2 | CLI exit code for `duplicate_candidate` (and other unmapped error codes) on the create interception path | §6.1 | §7.2 maps exit codes only for not_found (4), item_not_found (1), invalid_argument (2), internal (1); `duplicate_candidate`/`dedupe_suppressed`/`validation` fallback is unstated | A CLI-exit-code table covering every §7.1 error code |
| U3 | Exact `backlog --help` layout (six-verb listing + host-command carve-out section) | §1.1 | The verb set and carve-out are pinned (AC-0); the help text/format is not | The shipped CLI help output |
| U4 | `GET /` body shape: `{ ok, data: { operations: [...], mount, transport } }` | §1.3 | AC-1 pins the mount root and that GET / "lists the served operations"; the JSON shape is unstated | The served route response |
| U5 | OpenAPI path spellings (`/get`, `/query`, …) under /meta/openapi | §1.4 | AC-2 pins the route and that paths cover every operation; the plugin's path convention is mentioned, exact spellings not | The generated OpenAPI document |
| U6 | `view:summary` JSON field names (`window`, `perStatus`, `transitions`, `cycleTime`, `reopenRate`) | §5.1 | AC-15 pins `coverage: { itemsWithHistory, itemsTotal, auditWindowStart }` and the components (per-status counts, median/p90, reopen rate); the remaining keys are inferred | The summary view's documented output schema |
| U7 | Parent/root inclusion in `view:ready` (PLAN-001 present per the literal predicate) | §5.4 | AC-31 pins the predicate (non-terminal ∧ unclaimed ∧ unblocked); whether epics/root items are excluded is unstated | ready-items v1 semantics for parent items / a spec statement |
| U8 | CLI `backlog create` flag spellings (`--title`, `--kind`, `--repo`, `--by`, `--duplicate-action`, `--supersedes`) | §6.1, §6.2, §6.4 | §3 pins the JSON signature (`input`, `duplicateAction`, `supersedes`); CLI kebab spellings are inferred from the §7.3 grammar convention and AC-26's `--human-id`/`--by` | The shipped CLI create help / flag table |
| U9 | CLI spelling `--weight-fn count` for `view:plan`'s `weightFn` param | §4.3 | AC-30 pins `weightFn:"count"` in the JSON form; the CLI flag spelling is inferred | The shipped CLI help / spec flag table |
| U10 | `backlog get` on a soft-deleted item: reachable card + audit (vs `soft_deleted` error code) | §5.3 | §1 lists `soft_deleted` among outcomes yet requires audit history to remain reachable (BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001); the exact split (which call form gets the card vs the code) is unstated | The resolved §9 Q7 tombstone-lookup design |
| U12 | v2 markdown import fixture syntax for `backlog admin --action import` (how author/reporter/files/plan/dependency metadata are expressed) | §2.4, fixture file | §6 absorbs import-from-markdown into admin `import`; the v2 file format carrying dimensional fields is not pinned | The import action's documented file format |
| U13 | CLI store-path flag spelling `--store tmp/backlog-demo` on admin/import | §2.4 | The store path is needed to keep the demo isolated to `tmp/` (AGENTS.md §10); the flag spelling is inferred | The shipped CLI config/store-path surface |
| U14 | Zero-vector-weight control knob spelling `semanticWeight: 0.0` | §3.4 | AC-9 and RAG-SPEC §8 test-1 name the control ("zero the vector weight") but no surface parameter | The semantic-channel configuration surface (EPIC-G) |

## Scope gaps & open questions

- **AC-8 second half depends on EPIC-A** — the project-level traversal cannot be verified
  until the repo/project node model and aggregateBy land; the demo pins the *contract*
  (project of the dependent repo) and stubs the invocation (U1).
- **Embedding-dependent beats** (§3.1, §3.4, §3.5) require the sox embedding service via
  the `embedding-remote` plugin (PLUGIN_ARCHITECTURE.md). The demo declares the
  `rag_not_configured` fallback path (§5.4) for stores without it — a runner without the
  service executes the degrade beats and skips the semantic ones, which must be recorded
  in the Sign-Off notes.
- **`--humanIds "[BUG-6,FEAT-2]"` spelling** (AC-28's literal) is camelCase inside an
  otherwise kebab-case CLI flag convention (§7.3). The demo uses the AC's literal as
  instructed; the inconsistency is flagged for the implementer, not resolved here.
- **CLI exit code for `validation`** is exercised (§5.1 shows exit 2, matching
  apigen-base-errors' mapping of invalid_argument:2) but the spec enumerates only four
  codes; `validation`'s mapping is implied, not stated.
- No other scope gaps — every interface not listed above is grounded in the four specs
  (INTERFACE_v2, GRAPH_MODEL_v2, PLUGIN_ARCHITECTURE, RAG-SPEC).
