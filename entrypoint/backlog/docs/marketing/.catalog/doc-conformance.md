# Doc conformance — `entrypoint/backlog`

Assessed against a shipped v1.0.0 library/CLI/service at `9df2a5c7` (docs on disk re-read 2026-09-24T00:29Z, working tree ahead of HEAD). Machine contract for comparison: `capabilities.json`.

## Headline proportions
- **JUNK:** ~17% (2 of 12 docs — `STATE.md`, `BACKLOG_BACKLOG.md`)
- **REDUNDANT:** ~0% (README ↔ SKILL overlap is deliberate: human reader vs agent-facing)
- **UNDOCUMENTED:** ~0% (all 25 capabilities are represented across README / SKILL / SPEC; the three stats views are now documented on all three surfaces)
- **Conformant:** ~83%

## Per-document verdicts

| Doc | Verdict | One-line reason |
|-----|---------|-----------------|
| `README.md` | **KEEP** | Now carries an "Eighteen operations" table (`get`…`batch action`) and a "Rollup & stats views" section that documents the three stats verbs as CLI+MCP+library with real captured outputs. Accurate; quality: none. |
| `LICENSE` | **KEEP** (new) | MIT License, copyright 2026 pseudosky — matches `package.json` `"license":"MIT"`. Closes the previously-missing license file. |
| `skill/SKILL.md` | **KEEP** | §1 header now "17 verbs (plus `batch`)"; §8 "Rollup & stats views — mounted AND importable" documents the three as mounted ops + library exports with a worked transcript. Canonical agent surface; quality: none. |
| `SPEC.md` | **KEEP** | Header status stamp is now **`Status: IMPLEMENTED`** ("the surface this spec describes is realized in `src/` and shipped as `@adhd/backlog`, package version 1.0.0") — the prior `PROPOSED` contradiction is resolved. |
| `CHANGELOG.md` | **REVISE** | `## 1.0.0` Features bullet still reads "the application layer settles on **14 verbs**" while 17 verbs + `batch` ship — a count now contradicted by README/SKILL/`--help`. Quality: `INCORRECT`, `REVISE` (verb count). |
| `DATA_MODEL.md` | **KEEP** | Node/edge model matches `src/write/*` + `store/type-policy.ts`; current. |
| `DESIGN.md` | **REVISE** | `**Version:** 0.2.0` while the package ships 1.0.0 — stale version stamp; body otherwise mirrors real signatures. Quality: `REVISE` (stamp). |
| `PLUGIN_ARCHITECTURE.md` | **KEEP** | Exemplary: explicitly retracts the never-shipped plugin host and points at the real seam (`write/bootstrap.ts`). Quality: none. |
| `RAG-SPEC.md` | **REVISE** | `**Version:** 0.4.0`; status line correctly distinguishes shipped §1–§3 from forward §4–§10, but the version stamp still sits in a 1.0.0 tree. Quality: `REVISE` (stamp only — the maturity split is now explicit). |
| `CONTRIBUTING.md` | **REVISE** | Top-of-file status callout (2026-09-24) states the `backlog-e2e-*` blind multi-agent harness is absent from the repo (`git log --all` has no history) and marks the strategy "intent, not a runnable procedure" — the inline correction is present, but the runnable contributing path is still missing. |
| `STATE.md` | **REMOVE** (→ `REVISE` if kept) | Stale rollout tracker: line 10 `Status as of 2026-09-18: mid-section A, section B (the real data cutover) not [started]` — directly contradicts a shipped 1.0.0. Quality: `INCORRECT`, `JUNK`. |
| `BACKLOG_BACKLOG.md` | **REMOVE** | Line 3 self-declares "**This is not a tracked backlog.** … nothing here is authoritative state" — 714-line dead audit artifact; the graph is the source of truth. Quality: `JUNK`. |

## Extracted orphans (correct, not represented in the canonical docs)
- **`CHANGELOG.md` undercounts the verb surface** ("14 verbs") — the steward should update it to 17 verbs + `batch`, reusing the README operation table as the source of truth.
- **`--version` is not a recognized flag** (the CLI prints the command table instead) although the package ships `version-info.ts`. No doc claims otherwise, but it is a surface gap worth noting.
- **Working tree is dirty for `README.md`, `skill/SKILL.md`, `SPEC.md`, `CONTRIBUTING.md`, and `dist/`** (`git status --porcelain`) — the on-disk content was edited and the binary rebuilt after `9df2a5c7`; the steward must commit/diff before treating these as published.
- **`sandbox-path` reports `embeddingEnabled:true`** for the production store on this machine, while README's table documents the default as `false` — machine-specific config, not a doc error, but a reader could be surprised.
- **`LICENSE` is not listed in `package.json` `files`** — harmless (npm always includes LICENSE/README), noted only so a future packlist audit doesn't flag it.
