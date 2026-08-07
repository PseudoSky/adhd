# Doc review — RELEASE.md — adhd

**VERDICT: FAIL**

---

## Lens 1 — Closed loop

**metric_1 (eliminated reader searches):** 7 → 2 (↓71%) — PASS. The rewrite eliminated 5 of the 7 baseline fallbacks. Remaining 2 are known and acknowledged (package count stale in old README; agent-core-env README boilerplate).

**undocumented%:** 55% → ~20%; **junk%:** 50% → ~8% — Both trending down. PASS on trend.

**Contradictions: 2 — FAIL**

| # | Assertion | Contradicts | Location |
|---|-----------|-------------|----------|
| 1 | "23 shipped, 1 roadmap, 1 deprecated" | Line 6 says "42 shipped capabilities"; capabilities.json has 42 shipped, 1 roadmap, 1 deprecated | RELEASE.md line 154 (footer) |
| 2 | "across 7 domains" (line 6) | Statistics table says "Monorepo domains \| 8" (line 144) | Internal contradiction |

The footer's "23 shipped" is a stale count from an earlier cartographer iteration (iter-2 reported ~22 shipped). The capabilities.json has since been expanded to 42 shipped entries. This is a present-tense factual error — the footer claims a count that is 19 short of reality.

The "7 domains" vs "8 domains" inconsistency is minor but still a contradiction within the document.

**Zero-contradictions rule → FAIL**

---

## Lens 2 — Template/rubric conformance

### Template requirements

| Requirement | Present? | Notes |
|-------------|----------|-------|
| Executive summary | ✓ | Lines 10-19, well-articulated |
| Themed sections | ✓ | 6 themed sections (backlog, build tooling, apigen, agent, environment, workspace hygiene) |
| Upgrade notes | ✓ | Lines 103-118, specific migration steps per package |
| Statistics table | ✓ | Lines 134-145 with 7 metrics |
| Changelog reference | ✓ | Links to CHANGELOG.md |
| Footer/colophon | ✓ | Line 154 (though contains stale count) |

### Link & asset integrity (executed resolver)

**ALL LINKS RESOLVE OK** — Zero missing targets. The resolver script confirmed:
- `./CHANGELOG.md` ✓
- `./docs/marketing/.catalog/capabilities.json` ✓

**No license/badge claim** — RELEASE.md doesn't assert a license or link to LICENSE, so no integrity issue there.

### Claim-to-receipt verification

All 10+ major feature claims resolve to `status: shipped` entries in capabilities.json (spot-checked: backlog CLI, build tooling 5 plugins, serve-core refactor, canonical route naming, usage accounting, budget enforcement, Claude CLI provider, rate cards, install-skill, environment cascade). **PASS.**

### Score: 75/100

**Deductions:**

| Issue | Points | Detail |
|-------|--------|--------|
| Contradictory shipped count (footer vs lede) | -15 | "23" in footer, "42" in lede — breaks reader trust |
| Contradictory domain count (7 vs 8) | -5 | Lede says 7, stats say 8 |
| Footer says "23 shipped, 1 roadmap, 1 deprecated" and then references CHANGELOG.md with "see CHANGELOG.md for the full per-entry changelog" — the wording is confusingly redundant between lines 150 and 154-155 | -5 | Repetitive closing lines |

---

## Lens 3 — Consumer test

**STATUS: UNTESTED — FAIL**

`docs/marketing/.catalog/consumer.md` does not exist. The steward must run `doc-consumer` to produce a consumer report for the RELEASE.md surface.

Per the gate rules: *"If consumer.md is absent, mark Lens 3 UNTESTED and FAIL with the instruction that the steward must run doc-consumer first."*

---

## Required fixes (ordered)

### BLOCKING (must do before re-review)

1. **Fix the footer's stale shipped count** (line 154)
   - Change `"23 shipped, 1 roadmap, 1 deprecated"` to `"42 shipped, 1 roadmap, 1 deprecated"`
   - This eliminates the contradiction with line 6 AND with capabilities.json
   - **Reference**: capabilities.json has 42 shipped entries (verified: `42 shipped + 1 deprecated + 1 roadmap = 44 total`)

2. **Fix the contradictory domain counts**
   - Option A: Change line 6 from "7 domains" to "8 domains" to match the statistics table
   - Option B: Change the statistics table from "8" to "7" and remove "backlog" from the domain list (since workspace.json has 7 groups and backlog is an entrypoint, not a domain group)
   - **Recommendation**: Option A (add "entrypoint" as the 8th to be accurate, or go with what the statistics table lists)

3. **Run doc-consumer** and save its report to `docs/marketing/.catalog/consumer.md`
   - This unlocks Lens 3 assessment

### HIGH (important for quality)

4. **Re-run cartographer** and append a metrics block to docs/marketing/.catalog/metrics.md that captures the current 42-shipped state
   - Current metrics blocks still report "22 shipped" — this is stale
   - A fresh run would confirm metric_1 (reader searches eliminated), undocumented%, and junk% for the RELEASE.md surface

5. **Consider removing or rewriting the footer (lines 154-155)**
   - It redundantly restates the changelog reference from line 150
   - The stale count was the only unique information it added, and it was wrong
   - A cleaner approach: just close with "Prepared by the doc-steward from verified catalog data." and let the stats table speak for the counts

---

## Summary

| Lens | Status | Blocking? |
|------|--------|-----------|
| Lens 1: Closed-loop | Contradictions detected (footer says 23 vs actual 42; 7 vs 8 domains) | YES |
| Lens 2: Conformance | Links okay; template structure okay; internal contradictions | YES (contradictions) |
| Lens 3: Consumer | consumer.md missing | YES |

The RELEASE.md is structurally sound and well-written. Its content is largely accurate. But the footer's stale "23 shipped" count is a hard contradiction with both the document's own lede and the canonical capabilities.json — which triggers an automatic FAIL under the zero-contradictions rule. The fix is a simple number correction.
