## Unreleased

### Fixed — workspace tooling & agent-instruction docs (2026-07-16)

**BUG-WORKSPACE-GEN-001 — `scripts/generate-lib.sh` was a drift factory, and a stale `CLAUDE.md` made agents prefer it over the correct generator.**

Root cause, two halves:

1. `scripts/generate-lib.sh` mapped `<layer>` -> `packages/{design-system,shared,features,testing,ai,node-tools,other}`. All 7 of those directories are gone (real `packages/` holds domain folders: agent, apigen, data, decompile, dispatch, environment, ui-react, workspace). It could not emit a single valid path. Its `ai|mcp) DIR="ai"` branch is the **upstream source** of the dead `packages/ai/*` paths that stranded the `agent-*` plan corpus (BUG-REGISTRY-001).
2. The correct generator (`@adhd/workspace-codegen-nx`) already existed and was documented correctly in `AGENTS.md` — but `CLAUDE.md`, the file actually injected into every agent session, **contradicted it** with the stale `./generate-lib.sh` cheat sheet, a §1 architecture table whose directories were 4/4 nonexistent, and §3 package names that were dead. Agents followed the injected wrong answer.

The conceptual error underneath: the old doc treated `layer` as determining the **directory**. It does not — `domain` is the directory, `layer` is an orthogonal Nx tag. That conflation *is* the layer->dir mapping.

Changes:
- `scripts/generate-lib.sh` replaced with a loud deprecation shim (exits 1, prints the correct invocation); original preserved at `scripts/generate-lib.sh.deprecated`.
- **`CLAUDE.md` is now a filesystem symlink -> `AGENTS.md`** (git mode 120000). The divergence class is structurally impossible now.
- `AGENTS.md` rewritten as the corrected union of both files, making the `domain`-is-directory / `layer`-is-tag distinction explicit, pinning the bare-name rule (`--name=agent-engine-migration` yields `agent-engine-agent-engine-migration`), and adding a "should this be a package at all?" gate.
- New `docs/contributing/conventions/package-naming.md`, linked from `AGENTS.md`.

Verified: `npx nx g @adhd/workspace-codegen-nx:engine --name=migration --group=agent --nxLayer=logic --platform=node --dry-run` -> `packages/agent/agent-engine-migration`, tags `domain:agent, pkg-kind:engine, pkg-class:foundation, layer:logic, platform:node, access:domain`.

**BUG-DISPATCH-009 — superseded dispatch plans relocated into the plan that supersedes them.**

`dispatch-completion` was authored to consolidate `dispatch-optimizer` (PoC) + `dispatch-production` (deferred track) + `dispatch-backlog-fill` (debt specs) (`dispatch-completion/SCOPE.md:4`). All 12 pending `dispatch-production` operations were verified mapped op-by-op onto live `dispatch-completion` states — zero uncovered. The three dirs were `git mv`'d (history preserved) to `docs/plan/dispatch-completion/superseded/`, with a README recording provenance, the coverage table, and a **supersede-don't-re-point** warning on their dead paths (re-pointing would resurrect a superseded plan into file-reservation conflict with the live one).

Correction recorded: the original defect claimed these dirs were "treated as live plans by corpus scans." They were not — discovery keys on `state.json` (`corpus-verify.js:findAllStateDirs`), none of the three has one, and none was in `plan-index.json`. The move was for human provenance, not scan hygiene.

Verified after the move: `gap-check.js docs/plan/dispatch-completion` PASSED (exit 0, 0 warnings); `cross-plan-check.js docs/plan` emits no lines for any of the three; live plan intact (`current_state: triage`, 24 states).

## 2.2.0 (2024-12-14)

This was a version bump only, there were no code changes.

## 2.1.1 (2024-12-12)

This was a version bump only, there were no code changes.

## 2.1.0 (2024-08-13)

This was a version bump only, there were no code changes.

# 2.0.0 (2024-08-13)

This was a version bump only, there were no code changes.

## 1.1.0 (2024-05-28)

This was a version bump only, there were no code changes.

# 1.0.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.7.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.6.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.5.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.4.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.3.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.2.0 (2024-05-28)

This was a version bump only, there were no code changes.

## 0.1.0 (2024-05-28)

This was a version bump only, there were no code changes.