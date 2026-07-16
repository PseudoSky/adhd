# Code Review — agent-provider (@adhd/agent-provider)

**Reviewer:** code-reviewer (opus 4.8)
**Scope:** `git diff 34ed69a -- packages/ai/agent-provider packages/ai/agent-mcp-types`
**States reviewed:** scaffold-package … seed-and-roundtrip (3815 insertions, 36 files, all additive)
**Date:** 2026-06-23

---

## Summary

A complete, high-quality implementation of the provider registry: Drizzle schema
(`provider_*` prefixed), three stores (provider/model/tool-format), the
`ProviderAdapterImpl`, the FEAT-007 tool emitter, and seed data — all backed by
67 passing tests against a real on-disk SQLite file with real migrations and
explicit close+reopen persistence proofs. Every cross-cutting invariant in
`_shared.md` is satisfied, the cross-package `agent-mcp-types` change is purely
additive, and `nx build agent-mcp` is unaffected. No blocking findings.

---

## Verification results (tool-grounded)

| Check | Result |
| :---- | :----- |
| `nx build agent-mcp` (agent-mcp NOT modified, must still build) | **exit 0** |
| `nx build agent-provider` (compiles, no cycle, deps resolve) | **exit 0** |
| `nx test agent-provider --skip-nx-cache` | **exit 0** — 6 files / 67 tests passed |
| `git diff 34ed69a --stat -- packages/ai/agent-mcp` | empty — agent-mcp untouched |
| Browser-import grep (`react`/`window`/`document`/`.css`) over src | clean (no matches) |

---

## Design-intent fidelity (what the structural audit can't catch)

- **[inv:adapter-in-types] — SATISFIED.** `ProviderAdapter` + `StreamChunk` are
  DEFINED in `packages/ai/agent-mcp-types/src/domain.ts` (appended after
  `ToolDefinition` at line 175) and re-exported from `index.ts`. `agent-provider`
  only IMPLEMENTS it: `src/adapter/provider-adapter.ts:5` imports
  `ProviderAdapter as IProviderAdapter` and `class ProviderAdapterImpl implements
  IProviderAdapter` (line 22). The interface is NOT re-declared in agent-provider.
  Dependency direction `agent-mcp-types ← agent-provider ← agent-mcp` is intact
  (agent-provider's package.json deps: only `@adhd/agent-mcp-types`).

- **Cross-package change is PURELY ADDITIVE.** `domain.ts` appends the new
  block after line 175 (`ToolDefinition.inputSchema`); no prior declaration
  modified or removed. `index.ts` appends one `export type` line. `Message`
  (referenced by the new interface) already exists (`domain.ts:82`).
  `nx build agent-mcp` confirms no regression.

- **resolveModelId reads the binding table — SATISFIED.**
  `src/store/model-store.ts:195-215` selects from `modelPlatformBindings` with
  `and(eq(modelId, …), eq(platform, …))` — the platform filter is the single
  gating clause and is exercised by negative-control tests
  (`roundtrip.test.ts:457-474`, `adapter-resolve.test.ts:116-155`) that prove
  the two platforms do NOT collapse to one value.

- **model_platform_bindings topology matches the decided provider/model topology.**
  Composite PK `(model_id, platform)` (`schema.ts:66`, migration
  `0001_*.sql` `PRIMARY KEY(model_id, platform)`). Seed bindings
  (`seed/bindings.ts:27-39`) map the four canonical models to both
  `claude_code` aliases and `claude_api` full ids per SEED_DATA §7
  (`claude_opus_4_8 → opus` / `claude-opus-4-8`, etc.).

---

## Invariant compliance

- **[inv:platform-node]** — tags `["layer:ai","platform:node"]` (`project.json:14`);
  no browser imports (grep clean). Pure Node + SQLite.
- **[inv:shared-db-prefix]** — every table is `provider_*` prefixed
  (`schema.ts:15,31,58,84`); single DB file, no `ATTACH DATABASE`.
- **[inv:lookup-not-enum]** — `providers.id`, `platform`, `provider_id`,
  `transport`, `auth_pattern`, `emit_shape` are all plain `text()` columns; no
  SQL enum, no CHECK constraint in any migration. New provider/platform = a
  seeded row.
- **No cross-package SQLite FK** — `model_id` (→ provider_models) and
  `provider_id` (→ provider_providers) are LOGICAL keys: no `.references()` in
  schema.ts, no `FOREIGN KEY` in any of the three migration SQL files. Verified
  by reading all three `drizzle/*.sql`.
- **Composite PKs are real `primaryKey()`** — `schema.ts:66` and `:95` use
  `primaryKey({ columns: [...] })`, not a non-unique `index()`; migrations emit
  real `PRIMARY KEY(...)`.
- **[inv:reopen-proves-persistence]** — `roundtrip.test.ts` and
  `adapter-resolve.test.ts` CLOSE the better-sqlite3 handle and REOPEN from the
  same path before reading (e.g. `roundtrip.test.ts:274-330`,
  `adapter-resolve.test.ts:98-114`). Boolean flags asserted to survive as JS
  booleans, not 0/1 (`roundtrip.test.ts:316-323`).
- **[inv:real-db-tests]** — `openDb()` opens a real on-disk file under
  `os.tmpdir()` and runs real Drizzle migrations via `runMigrationsOn`.
- **[inv:server-side-shape]** — `emit-tools.ts:125-135` emits `{type, name}`
  with NO `input_schema` for server_side; `emit-tools.test.ts:101` asserts
  `"input_schema" in emitted === false`. Custom shape asserted distinctly
  (`:179-185`).
- **[inv:gate-not-noop]** — `emit-tools.ts:137-144` THROWS
  `UnsupportedNativeToolError` (naming tool + provider + note); never a silent
  drop. `emit-tools.test.ts:122-157` asserts the throw, instance, and `.code`.

---

## CLAUDE.md compliance

- `@adhd/` workspace imports throughout; no relative cross-package paths.
- I-prefixed interface alias for the implemented contract
  (`ProviderAdapter as IProviderAdapter`); domain interfaces named per package
  convention.
- JSDoc on public store methods, the adapter, and the emitter (shared package).
- Verification standard met on all six points: real components (real DB/migrations,
  real stores, real adapter — only the LLM stream body is a deliberate stub for
  this state), assertions with teeth (platform-collapse + idempotency +
  unsupported-throw negative controls), deterministic (no sleeps), exit-code
  gated (no `grep -q passed`), persistence proven by reopen.
- **tsconfig.base.json** — surgical: the `@adhd/agent-provider` path was added
  to the `paths` map (additive); the diff also shows sibling registry paths from
  adjacent plans, no existing path modified.

---

## Non-blocking observations (informational — do NOT gate)

- `provider-adapter.ts` `stream()` is an intentional stub that yields a single
  text chunk surfacing the resolved id; this is by design for this state (live
  streaming is a later plan). The doc comment says so (lines 16-19) and the
  contract under test here is model resolution, which is fully proven.
- `idx_provider_mpb_model_id` (`schema.ts:67`) duplicates the leading column of
  the composite PK; SQLite's PK already provides a `(model_id, platform)` index,
  so a standalone `model_id` index is redundant for point lookups. Harmless;
  optional cleanup.

---

## Blocking findings

None.

---

VERDICT: APPROVED
