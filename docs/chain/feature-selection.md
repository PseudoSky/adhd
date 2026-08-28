# Chain Feature Selection — product stage

**Chain:** product → architect → typescript → review (fresh worktree)
**Worktree:** `.worktrees/chain-20260802-183630-6422a0`
**Date:** 2026-08-02
**Repo scope:** `PseudoSky/adhd` (313 items; 298 ready via `backlog ready-items`; 0 stale claims)

## Selected feature

**Human ID:** `FEAT-APIGEN-TS-TYPE-CODEGEN-001`
**Title:** apigen has no JSON-Schema→TS-type-declaration codegen path for any operation - a real gap in the core value proposition, not just a batch-spec detail

**State at selection:** OPEN · priority MEDIUM · kind FEAT · unclaimed (claimedBy=None, claimedAt=None; verified via `backlog get-item` and confirmed by `backlog stale-claims` = `[]`).

## Why this feature wins

### 1. User/business value — highest of every viable candidate
This is a **new capability**, not a fix, and it closes a stated gap in apigen's core value
proposition. Per `docs/apigen/SPEC.md` Tenet 0, apigen's purpose is code-first extraction that
projects to *every* transport/target **including "clients"**. Today a consumer gets typed access
only by being inside the same monorepo and importing hand-authored source functions; a
cross-service/cross-repo consumer has no first-party "generate a typed TS client SDK from the
descriptor" output. The item's body proves the gap by grep: zero hits for any JSON-Schema→TS
codegen in `packages/apigen` (only the reverse direction, `ts-json-schema.ts`).

Every existing apigen consumer in this monorepo (`@adhd/backlog`, `apigen-cli`, and by extension
`agent-mcp`/`dispatch-cli` — all apigen-driven) plus future external consumers gains a new output
target: `apigen generate --type <ts-types>`. That is a real, consumer-visible outcome on day one.

### 2. Clarity and self-containment — spec-able in one implementation round
The whole feature lives in the **apigen family** and touches at most **two packages**:

- **New plugin package** `packages/apigen/apigen-plugin-ts-types` (tier `plugin`, group `apigen`),
  structurally a copy of the existing generate-only `apigen-plugin-jsonschema` (~50-line
  `OutputPlugin` that iterates `input.packages` → `pkg.schemas[fnName]` and returns
  `{ files: [{path, content}] }`). The new plugin emits TS type declarations per function instead
  of JSON Schema files. No `run()` — generate-only, like `jsonschema`.
- **One registration line** in the plugin map at `entrypoint/apigen-cli/src/index.ts`
  (`const plugins: Record<string, OutputPlugin>`; see also `src/lib/plugin-registry.ts`, which
  auto-derives `list-types`/help from the map — no other wiring to touch).

The `jsonschema` plugin (`packages/apigen/apigen-plugin-jsonschema/src/lib/plugin.ts`) is the
verified template: `id`, `description`, `language`, `optionsSchema`, `generate(input) → {files}`.
Plugin tags convention (verified on `apigen-plugin-jsonschema/project.json`):
`tags: ['layer:logic', 'platform:node']`, targets `build/test/nx-release-publish`.

### 3. Feasibility in a fresh worktree
- Pure TypeScript, Nx-built, no DB, no external services, no network at test time.
- The apigen-cli test harness already spawns the built CLI with real fixtures
  (`entrypoint/apigen-cli/src/test/fixtures/{registry,shapes,...}`; BUG-APIGEN-032's repro uses
  `node dist/entrypoint/apigen-cli/index.js generate-registry ...`), so a consumer-outcome test
  that drives `apigen generate --type ts-types` on a fixture is the established pattern.
- The discriminated-union fixture has real provenance: `docs/spec/apigen/BATCH_0.0.1.md` and the
  shipped `_batch` synthetic mounts (apigen 0.0.1, 2026-07-28) — the exact case the item demands
  be "proven, not assumed."

### 4. Risk — medium-low, with one named design decision
- **Low:** bounded surface (one plugin + one registry line + tests); existing plugin pattern is a
  proven template; no changes to existing plugin behavior.
- **Medium (design decision for architect):** wrap `json-schema-to-typescript` vs hand-roll a
  minimal emitter. The item suggests adoption as one option, but (a) adding a 3rd-party dep needs
  human approval per AGENTS.md ("always get human approval before installing external tools"),
  and (b) `json-schema-to-typescript` does not natively model `discriminator` — so the
  discriminated-union fixture needs custom handling either way. Because apigen's schema subset is
  already bounded (schemas are TS-derived via `ts-json-schema-generator`), a hand-rolled emitter
  over that subset is the recommended default. Architect must decide and state the trade-off.

## Acceptance bar (consumer-visible outcome)

1. `apigen list-types` lists the new target id (e.g. `ts-types`) with `(generate)` capability;
   `apigen generate --source <fixture>.ts --type ts-types --out-dir <dir>` exits 0 and writes one
   `.ts` file per function whose content is **valid TS type declarations derived from the
   function's JSON Schema** (parameter/return types; named types emitted, not inline `object`).
2. **Generated output compiles** under the repo tsconfig — verified with `esbuild` or
   `tsc --noEmit` in the test (explicitly NOT `node --check`, which BUG-APIGEN-032 proved
   permissive). This is the teeth: the negative control (emitting invalid TS, e.g. a bare `-`
   identifier splice) must fail this check.
3. **Discriminated-union fixture proven:** a `oneOf` + `discriminator` schema (the `_batch`
   shape from `BATCH_0.0.1.md`, or an equivalent fixture) yields a usable union type — each
   branch emitted and the discriminant retained — not a degraded `any`/`unknown`/`object`.
4. **Default-running test, no env gate:** at least one test drives the real CLI path the way a
   consumer does (spawn the built CLI against a fixture, or the plugin's own integration test
   against real composed schemas) and asserts exit code + emitted file contents. Unit tests on
   `plugin.generate()` are fine as complement, not substitute.
5. **Hyphenated package ids** (the monorepo norm) produce valid identifiers — reuse the
   `sanitizeIdentifier` pattern already in `apigen-plugin-cli-output/src/lib/generate.ts:66-70`
   (BUG-APIGEN-032 is the cautionary tale).
6. **Docs updated:** `docs/apigen/SPEC.md` (new output target) and the apigen-cli package
   `AGENTS.md` plugin table, per the repo rule "always update relevant docs to include surface
   features added."

## What the architect must produce

A design + implementation spec covering:

1. **New package:** `packages/apigen/apigen-plugin-ts-types` scaffolded via the MANDATORY
   generator `npx nx g @adhd/workspace-codegen-nx:plugin --name ts-types --group apigen
   --nxLayer logic --platform node` (dry-run first; bare name, generator composes
   `apigen-plugin-ts-types`). Target id decision: `ts-types` (or `ts-client`) — pick one,
   register it in `entrypoint/apigen-cli/src/index.ts`'s `plugins` map.
2. **Emitter design:** the JSON-Schema→TS mapping table for the bounded apigen subset
   (primitive → `string`/`number`/`boolean`; `object`/`required` → interface; `oneOf` +
   `discriminator` → discriminated union; arrays, enums, refs). Explicit statement of which
   schema constructs are supported vs rejected-with-clear-error in round 1.
3. **Dependency decision:** hand-rolled emitter (recommended) vs `json-schema-to-typescript`
   wrap, with the trade-off stated. If the wrap is chosen, flag that external-dep approval is
   required per AGENTS.md before install.
4. **Fixture + tests:** new fixture in `entrypoint/apigen-cli/src/test/fixtures/` (or reuse
   `shapes`) including a discriminated-union case; unit tests for the emitter; at least one
   consumer-path test (CLI spawn or plugin-against-real-composed-schemas); compile check with
   esbuild/`tsc --noEmit`.
5. **Repo conventions to honor:** packages live under `packages/apigen/`; tags
   `layer:logic, platform:node`; `@adhd/*` scoped imports matching package.json names exactly;
   pnpm for any JS install (repo is yarn→pnpm-migrating; do not add new yarn/npm artifacts);
   Nx targets via `npx nx build/test/lint <project>`; never `tsc` by hand; never
   `--skip-nx-cache`; affected-tests via `npx nx affected -t test` when dependents exist;
   artifacts under `tmp/`; conventional commits (`feat(apigen): ...`).
6. **Verification:** `npx nx build apigen-plugin-ts-types` + `npx nx test apigen-plugin-ts-types`
   + `npx nx lint apigen-plugin-ts-types` + build & test `apigen-cli` (the consumer) — all green
   in the worktree, exit codes trusted.

## Candidates evaluated and rejected

| Item | Priority | Rejected because |
|---|---|---|
| FEAT-APIGEN-TS-TYPE-CODEGEN-001 | MEDIUM | **SELECTED** |
| BUG-APIGEN-032 (invalid TS for hyphenated pkg ids in `-registry` output) | — (OPEN) | Excellent fit (tiny, low risk, same sanitize concern) but a bug fix with modest value; the chain is feature-selecting, and this is a strong *second* pick if the selected feature collapses. |
| FEAT-APIGEN-024 (log failures to disk) | MEDIUM | Real DX value but lower strategic weight than TS-codegen; touches logging infra more broadly. |
| BUG-DISPATCH-002 (dispatch-cli has no `bin`) | MEDIUM | Entangled scope: depends on BUG-DISPATCH-001 (`--help`) + DEBT-DISPATCH-021/022; smaller consumer base. |
| BUG-AGENTMCP-006 (opencode MCP install broken) | HIGH | Verification requires a real opencode host session (TASK-001 notes clean-room host-session e2e is MISSING) — not teeth-verifiable in a fresh worktree. Rejected on verification grounds, despite HIGH priority. |
| FEAT-BACKLOG-008 (backlog doctor) | LOW | Good but LOW priority nice-to-have on a tooling surface that already has many open items. |
| FEAT-AGENT-001 (apigen-style agent-mcp entrypoint refactor) | HIGH | Far too large for one implementation round (client.ts + 3 transports + serve). |
| FEAT-APIGEN-SERVE-CORE-005 (serve-core Phase 1) | — | Mid-large architecture piece inside a multi-phase epic (Phase 4 parked; open RISK items); larger blast radius than one plugin. |
| BUG-APIGEN-031, BUG-APIGEN-037, BUG-WORKSPACE-GEN-002/006, BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001, DEBT-* | — | Lower user-visible value than the selected feature; DEBT items were deprioritized per the "no pure debt without clear user-visible outcome" rule. |

## Blockers / gaps noticed

1. **Fresh worktree has no `node_modules`** (verified: worktree dir empty of it; a `require.resolve`
   only succeeds via the bare repo root's install). The typescript stage must run the repo's
   install (`corepack yarn install` / pnpm path) **before** any `lint`/dependency-checks, per
   AGENTS.md's warning on `BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001`.
2. **External-dep approval:** if the architect chooses `json-schema-to-typescript`, human
   approval is required before installing (AGENTS.md rule). Flagged in the spec; default
   recommendation is the dependency-free hand-rolled emitter.
3. **`discriminator` handling is not turnkey anywhere** (neither the adopt option nor a naive
   emitter models it natively) — the design must specify the union emission strategy explicitly;
   this is the one genuinely novel piece of the feature.
4. **Docs updates are part of scope** (`docs/apigen/SPEC.md` + apigen-cli AGENTS.md plugin table);
   the architect should include them so the feature ships with its surface documented.

**Verdict: PROCEED — FEAT-APIGEN-TS-TYPE-CODEGEN-001.**
