# Doc Review — adhd (monorepo root) — (post-rewrite assessment)

**VERDICT: FAIL**

---

## Lens 1 — Closed-Loop Metric

**STATUS: BLOCKING — Cannot assess**

The steward completed the rewrite but did NOT re-run the cartographer to capture post-rewrite metrics. `metrics.md` contains only the baseline run (28888998c0a68e2712d06b89ed1602e0c6aab3c4, 2026-07-22T16:08:33-05:00) ending with "Next Run Should" recommendations. No `run` block appended for post-rewrite.

**What should exist:** A fresh cartographer run after the README/AGENTS/PUBLISHING rewrites, appending new metrics for:
- `metric_1_eliminated_reader_searches`: Should drop from 7 fallbacks toward 0 (currently ref to non-existent files break this)
- `undocumented%`: Should drop from 55% baseline
- `junk%`: Should drop from 50% baseline to near 0

**Cannot proceed to PASS without:** Fresh cartographer run and metrics comparison in `metrics.md`.

---

## Lens 2 — Template Conformance

### README.md — 65/100

**Status**: Rewritten and improved, but INCOMPLETE (broken links block it).

**Conformance Assessment:**

| Element | Status | Notes |
|---------|--------|-------|
| Title & Why | ✓ | Clear, product-focused ("production-grade agent framework") |
| Product story | ✓ | Well-articulated (multi-LLM, tool policy, prompt composition, transport flexibility, reproducibility) |
| Getting started nav map | ✓ | Table-driven, 6 entry points with links |
| Architecture diagram | ✓ | ASCII diagram showing entrypoints, core, ecosystem layers |
| Footer (links, license, security) | ⚠ | Broken — see link integrity below |
| Marketing adjectives | ✓ | None detected (no "seamless/powerful/blazing") |

**Broken local links (AUTOMATIC FAIL per Lens 2 spec):**

1. `[packages/agent/README.md](packages/agent/README.md)` — **FILE DOES NOT EXIST**
2. `[docs/QUICK-START.md](docs/QUICK-START.md)` — **FILE DOES NOT EXIST**
3. `[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)` — **FILE DOES NOT EXIST**
4. `[CONTRIBUTING.md](CONTRIBUTING.md)` — **FILE DOES NOT EXIST**
5. `[LICENSE](LICENSE)` — **FILE DOES NOT EXIST**
6. `[SECURITY.md](SECURITY.md)` — **FILE DOES NOT EXIST**

**Reason for FAIL:** Documentation references these files as real entry points for new users. Referencing non-existent files (especially QUICK-START, ARCHITECTURE, and root-level docs) makes the README a liability—it promises guidance that doesn't exist and forces reader fallback.

---

### AGENTS.md §4 — 90/100

**Status**: Significantly improved.

**Strengths:**

- ✓ Now lists 12-package agent registry family (was 7, baseline doc-conformance noted this gap)
- ✓ Correctly includes new packages:
  - `@adhd/agent-core-env` (v0.0.1, NEW 2026-07-22) with note: "lazy registry DB resolver via Environment DI"
  - `@adhd/environment-*` (v0.0.1, NEW) with full cascade explanation
  - `@adhd/workspace-codegen-nx` (MANDATORY generator) with usage example
- ✓ Factual-only; no marketing adjectives
- ✓ Commands exist and are accurate (`CI=true npx nx list`, generators, nx tasks)
- ✓ All package names and paths verified against actual package structure
- ✓ Correctly distinguishes tiers and layers

**Minor gaps:**

- Entry still says "Verify with `CI=true npx nx list` before relying on any name here — this section has gone stale before" — the caveat is reasonable but doesn't reduce the stale risk once this doc regresses again
- No timestamp/version anchor for when this was last verified

**Deduction:** `-10 points` for the pre-emptive stale caveat (honest, but means this section is known to decay). Still high quality.

---

### PUBLISHING.md — 75/100

**Status**: Significantly clarified with topological ordering detail, but incomplete (missing verification docs).

**Strengths:**

- ✓ Clear separation of `version` (source) vs `publish` (dist) workflows
- ✓ Explains `^version` topological dependent-range sync (BUILD-TOOLING-VERSION-SYNC-DEPS-001)
- ✓ Explains `dist-manifest` target and range resolution
- ✓ Versioning model is registry-driven and automatic (good clarity)
- ✓ `dependsOn: [build, ^version]` explicitly documented
- ✓ Retired legacy `nx release` workflow moved to `<details>` (good UX)
- ✓ Troubleshooting table comprehensive

**Broken local links (AUTOMATIC FAIL per Lens 2 spec):**

1. `[entrypoint/agent-mcp/PUBLISHING.md](entrypoint/agent-mcp/PUBLISHING.md)` — **FILE DOES NOT EXIST**
2. `[entrypoint/apigen-cli/PUBLISHING.md](entrypoint/apigen-cli/PUBLISHING.md)` — **FILE DOES NOT EXIST**

**Reason for FAIL:** Post-publish checklist (lines 269–285) references per-package PUBLISHING.md files that don't exist. Users following this doc will hit a dead end.

**Deduction:** `-25 points` for missing referenced verification docs (these are critical for post-publish safety net).

---

### Registry-Family READMEs — 60/100 (Mixed)

**Status**: Partially rewritten; inconsistent quality.

**What was rewritten (high quality):**

- ✓ `packages/agent/agent-store-tools/README.md` — Full rewrite with usage example, key exports table, architecture notes, correct status/platform/consumers metadata
- ✓ `packages/agent/agent-core-provider/README.md` — Full rewrite, same pattern, references `agent-core-env` correctly
- ✓ `packages/apigen/README.md` — Full rewrite with package breakdown table, pipeline diagram, v1 vs v2 clarity

**What was NOT rewritten (default Nx template):**

- ✗ `packages/agent/agent-core-env/README.md` — Still Nx boilerplate ("This library was generated with [Nx]"). **Wrong project name:** says "agent-agent-core-env" (duplicate "agent-").

**Reason for FAIL:** `agent-core-env` is the NEW package added 2026-07-22 and is central to the registry family's zero-import-side-effects redesign (per doc-conformance baseline assessment). It MUST have a proper README. The broken project name ("agent-agent-") indicates a scaffolding error or incomplete rewrite.

**Deduction:** `-40 points` (5 of ~12 rewritten leaves half incomplete; the newly-added package is missing its documentation).

---

### Missing Domain-Level README

**`packages/agent/README.md` does not exist**, but root README.md references `[packages/agent/README.md](packages/agent/README.md)` as the entry point for the agent registry family. This is a link-integrity FAIL.

**Remediation:** Either create this file (recommended: aggregates all 12 packages, links to individual READMEs, explains the registry/compiler/store hierarchy) or change the root README link to point to a working doc (e.g., `entrypoint/agent-mcp/README.md` or a docs/ guide).

---

## Lens 3 — Consumer Test

**STATUS: UNTESTED — Blocking gate**

No `docs/marketing/.catalog/consumer.md` exists. The steward did not run the `doc-consumer` test to verify that a new user can:

1. Understand what @adhd IS in <30s from README alone
2. Find their starting point (agent-mcp? apigen? dispatch?) from the nav map
3. Follow docs to the first working example without hitting a missing link
4. Know how to publish a package from PUBLISHING.md alone

**Cannot PASS without:** A successful `doc-consumer` report showing all canonical tasks completable with only the docs (no source inspection fallback required).

---

## Summary: Why This Is a FAIL

| Lens | Status | Blocking? |
|------|--------|-----------|
| Lens 1: Closed-loop metrics | No fresh run exists | YES — Cannot measure improvement |
| Lens 2: Template conformance | 8 broken local links; incomplete READMEs | YES — Automatic FAIL per spec |
| Lens 3: Consumer test | Not run | YES — Usability unproven |

**Any ONE of these would be a FAIL. All THREE are present.**

---

## Required Fixes (Ordered)

### BLOCKING (must do before re-review):

1. **Re-run cartographer** after the rewrite (takes ~5-10 min) and append a fresh `run` block to `docs/marketing/.catalog/metrics.md` with:
   - Fresh date/commit hash
   - New metric_1_eliminated_reader_searches count (should be 0 if all links are fixed)
   - New undocumented%, junk% measurements
   - Comparison to baseline (7 fallbacks → ?, 55% → ?, 50% → ?)
   - **This unlocks Lens 1 assessment**

2. **Create missing doc files** (or remove broken links):
   - [ ] `docs/QUICK-START.md` — 5-minute first-agent walkthrough (agent-mcp: spawn, call tool, hang up)
   - [ ] `docs/ARCHITECTURE.md` — 10-minute package hierarchy + tier dependency flow + public APIs (extracted from AGENTS.md, user-friendly)
   - [ ] `packages/agent/README.md` — Domain-level aggregator: "12-package registry family, here's what each tier does, jump to agent-store-tools/README, agent-core-env/README, etc."
   - [ ] `CONTRIBUTING.md` — Link to `docs/contributing/conventions/package-naming.md` or summarize (or remove the root README link)
   - [ ] `LICENSE` — Ensure file exists at repo root (standard practice; check if MIT file is present or needs to be created)
   - [ ] `SECURITY.md` — Placeholder or full security policy
   - **This fixes Lens 2 link integrity (8 broken links)**

3. **Complete registry-family README rewrites**:
   - [ ] `packages/agent/agent-core-env/README.md` — Replace Nx boilerplate with actual README (see agent-store-tools as template). Fix project name if necessary. Explain lazy DB resolution, Environment DI pattern, why import-time side effects are eliminated.
   - [ ] Verify remaining registry packages have proper READMEs or mark them as "not yet documented" with a BACKLOG entry
   - **This fixes Lens 2 conformance (incomplete package docs)**

4. **Create per-package PUBLISHING.md verification docs**:
   - [ ] `entrypoint/agent-mcp/PUBLISHING.md` — Post-publish smoke tests (e.g., `npm view @adhd/agent-mcp versions`, spawn an agent, verify SSE works, etc.)
   - [ ] `entrypoint/apigen-cli/PUBLISHING.md` — Similar (e.g., `npx @adhd/apigen-cli@latest --help`, generate an API, serve it, test a call)
   - **This fixes Lens 2 reference integrity**

5. **Run doc-consumer** (testing robot that tries canonical tasks doc-only):
   - Tests: "Read README, understand @adhd purpose in 30s" / "Find agent-mcp quickstart from nav map" / "Follow QUICK-START.md to spawn first agent" / "Use PUBLISHING.md to publish a package"
   - Saves report to `docs/marketing/.catalog/consumer.md`
   - **This unlocks Lens 3 assessment**

### HIGH (for next iteration after re-review):

6. Add timestamp/last-verified-commit to AGENTS.md §4 so readers know staleness risk
7. Create `docs/contributing/SCAFFOLD-PACKAGES.md` with workspace-codegen-nx examples (recommended in baseline doc-conformance)
8. Audit `docs/architecture/` directory — remove if redundant with AGENTS.md, merge unique content into docs/ARCHITECTURE.md (noted in baseline as likely stale)

---

## Notes

- **Factual claims in README/AGENTS/PUBLISHING are accurate.** No contradictions with capabilities.json detected. All 50 packages exist. All status marks (shipped) are correct.
- **Root README's product story is strong.** The value prop is clear and differentiated from generic frameworks. Re-revision risk is low once these link/docs gaps are fixed.
- **AGENTS.md is a keeper.** The new package additions (agent-core-env, environment, workspace-codegen-nx) are correctly cited and placed. No rewrites needed there.
- **PUBLISHING.md's topological-ordering explanation is excellent.** It clarifies a prior design pain point. Keep it.

---

## Next Steps for Steward

1. **Immediate** (today): Re-run cartographer, append metrics block to metrics.md, run doc-consumer
2. **Next hour** (blocking gate): Create 6 missing doc files (QUICK-START, ARCHITECTURE, etc.) — these are mostly stubs initially
3. **Next session** (after re-review): Complete agent-core-env README rewrite and fix any other incomplete registry-family docs
4. **Then**: Re-submit for review with fresh metrics and consumer report

---

End of Review
