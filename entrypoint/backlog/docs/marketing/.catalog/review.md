# Doc review — `entrypoint/backlog` (`@adhd/backlog`) — `9df2a5c7`

VERDICT: **FAIL**

Reviewed surface: `README.md`, `CHANGELOG.md`, `skill/SKILL.md`, `SPEC.md`,
`DATA_MODEL.md`, `DESIGN.md`, `PLUGIN_ARCHITECTURE.md`, `RAG-SPEC.md`,
`CONTRIBUTING.md`, `LICENSE`, `STATE.md`, `BACKLOG_BACKLOG.md`, plus the scope's
own catalog under `docs/marketing/.catalog/` (`capabilities.json`, `metrics.md`
[BEFORE]+[AFTER], `doc-conformance.md`, `consumer.md`).

Evidence is re-derived from the artifact, not from the steward's intent: the
built `entrypoint/backlog/dist/index.js` was executed (exit 0), `package.json`
was read as the canonical manifest, and a link resolver was run over every
owned `*.md` (not reasoned). Where the catalog and the artifact disagree, the
artifact wins.

---

## Lens 1 — closed loop

**metric_1: 0 → 0 — FAIL.**
`metrics.md` now carries a real `[BEFORE]` and `[AFTER]` pair (the prior
"no after-run" defect is fixed) and both report
`metric_1_eliminated_reader_searches: 0`. The weak inequality holds only
trivially, and the metric is not credible:

1. **No reduction.** 0 → 0 is not "trending to 0"; by the brief, a rewrite that
   does not reduce the number of times a reader must bypass docs into source has
   not improved usability.
2. **Falsified by the steward's own Lens-3 evidence.** `consumer.md` (produced
   in this same pass) documents the reader-search moments explicitly:
   *"Consolidated reader-search moments: kind vocabulary (Task 2); the `terminal`
   flag of `closed` (Task 2); the full `filter` key set (Task 2);
   owner-of-an-unregistered-file (Task 3); the `view:"lookup"` contradiction
   (Task 3)"* — and marks Task 2 *"Fixing it needs **source**
   (`src/write/catalog.ts` seed rows)"* (HIGH signal). A metric of 0 cannot
   coexist with a consumer report that logs ≥4 fallbacks on 2 of 3 tasks.
3. **Unfalsifiable baseline.** The `[BEFORE]` value is self-declared an
   *"Estimate from the skill doc"*; a baseline fixed at 0 by fiat makes the gate
   vacuously true.

**undocumented%: 0% → 0%** (no drop — and contradicted by `consumer.md`, see
Lens 3). **junk%: 18% → 17%** (drops 1 pp toward 0 — the only metric that
moves; weak pass on junk alone).

Both blocks are stamped to the **same** HEAD sha and describe the same
**uncommitted working tree** (`git status` → `M README.md`, `M skill/SKILL.md`,
`M SPEC.md`, `M CONTRIBUTING.md`, `?? LICENSE`, `?? docs/marketing/`), so the
"loop" compares a dirty tree against itself.

**contradictions: 9 (hard) + catalog inaccuracies — FAIL.** Owned docs assert
present-tense facts the artifact/manifest/canonical inventory falsify:

| # | Doc assertion | Contradicted by | Where |
|---|---------------|-----------------|-------|
| C1 | `priorityMatrix` is a **mounted** operation: README §Command surface table row + §Rollup "available **both** as mounted operations (`priority-matrix`, …)"; SKILL §1 command list + §8 "mounted AND importable" with MCP tool `backlog_priority_matrix`; `capabilities.json` `priority-matrix` `surface:"cli+mcp+http+library"` and `verified_output:"backlog priority-matrix { input: { filter?: object } }"` / *"mounted verb listed in live --help (exit 0)"*. | The built binary **does not mount it**: `node dist/index.js --help` lists 16 `backlog <verb>` lines **without** `priority-matrix` (`rg -c 'priority-matrix'` → 0), and `node dist/index.js priority-matrix --input '{}'` returns `{"code":"not_found","message":"Unknown command: backlog priority-matrix…"}`. Root cause in the working tree: `src/api.ts:478` carries an **un-reverted negative control** — *"NEGATIVE CONTROL (temporary, reverted immediately): the `export` keyword is removed so `priorityMatrix` is not mounted"* — and `src/index.ts`'s export list (the extraction surface) omits `priorityMatrix`. | README §Command surface / §Rollup; SKILL §1/§8; `capabilities.json` id `priority-matrix` |
| C2 | README "**Eighteen operations**"; SKILL §1 "**17 verbs** (plus `batch`)". | Live `--help` mounts **16** verbs + `batch action` = 17 commands. (Same root as C1: the count includes the unmounted `priority-matrix`.) | README:193; SKILL:29 |
| C3 | `CHANGELOG.md` `## 1.0.0` bullet: "the application layer settles on **14 verbs**". | `capabilities.json` `mounted_operations.verbs: 17`; README/SKILL operation tables. | CHANGELOG.md:7 |
| C4 | `CHANGELOG.md` heading `## 1.0.0 (Unreleased)`. | `capabilities.json` `"version":"1.0.0"`, all 25 entries `status:"shipped"` — 1.0.0 is shipped, not unreleased. | CHANGELOG.md:1 |
| C5 | `STATE.md`: *"Status as of 2026-09-18: mid-section A, section B (the real data cutover) not started, **nothing pushed or published**"*; §Wave 3 "3a … not started". | Shipped 1.0.0 (`capabilities.json`; merged `545d7025`). | STATE.md:10-11, 2123 |
| C6 | `SPEC.md` §0 "Library versions (**verified on npm**): `@adhd/sox-graph-store@0.9.1` … `@adhd/sox-store-adapter@0.9.0` … `@adhd/sox-vector-store@0.6.0`, `@adhd/sox-hybrid-search@0.4.2`, `@adhd/sox-embedding-provider@0.4.1`, `@adhd/sox-memory-core@0.9.2`". | `package.json`: `sox-graph-store ^0.10.1`, `sox-store-adapter ^0.9.2`, `sox-vector-store ^0.7.0` (opt), `sox-hybrid-search ^0.4.6`, `sox-embedding-provider ^0.5.3`; `@adhd/sox-memory-core` is **not a dependency at all**. A present-tense "verified on npm" claim that is false against the canonical manifest. | SPEC.md:20-28 |
| C7 | `DESIGN.md` dependency block pins `@adhd/sox-graph-store ^0.9.1`, `sox-store-adapter ^0.9.1`, `sox-hybrid-search ^0.4.2`, `sox-embedding-provider ^0.4.1`, `sox-vector-store ^0.6.0`; `RAG-SPEC.md` §0 pins "`@adhd/sox-graph-store` 0.6.0". Also `DESIGN.md` `**Version:** 0.2.0` and `RAG-SPEC.md` `**Version:** 0.4.0` in a 1.0.0 tree. | `package.json` pins above; package version `1.0.0`. | DESIGN.md:3,540-548; RAG-SPEC.md:3,14 |
| C8 | `SPEC.md` §6.7: "CLI/MCP/HTTP each mount the **nine issue verbs plus §3a's registry verbs**" — no mention of the stats reads. | SPEC §5 itself declares the priority matrix / rollup / open-curve as part of the surface, and README/SKILL present them as mounted. Internal contradiction. | SPEC.md:2734 vs SPEC.md:948-954 |
| C9 | `SKILL.md` §1 embedded `$ adhd-backlog --help` transcript is presented as *"the exact live shape of every input"* / *"Trust that output over anything hardcoded here — it is the live schema"*. | The embedded transcript lists only 14 verbs + `batch` (it omits `priority-matrix`, `part-of-rollup`, `open-curve`), while §1's own header says 17 verbs and the actual live help lists 16 verbs (including `open-curve`/`part-of-rollup`). The doc's most-emphasised trust anchor is stale. | SKILL.md:62-84 |

C1 is the most serious: it is a present-tense, load-bearing claim duplicated
across the two primary consumer docs **and** the machine contract, and the
catalog records a `verified_output` the artifact does not produce. C1 also
matches the exact **un-reverted negative-control residue** failure mode the
repo's own `AGENTS.md` calls out (`DEBT-PROCESS-DISPATCH-RESIDUE-001`): the
source comment says the control is *"reverted immediately"*, but it is still in
the working tree.

---

## Lens 2 — conformance

**Template recall:** `memory_recall(topic:"doc-framework", tags:["kind:template"])`
returned the deterministic skeletons (README, AGENTS.md, CHANGELOG, Diátaxis
reference, plus the link/claim-backing review rule). Conformance below is scored
against those recalled templates + the review rubric.

**Link & asset integrity — EXECUTED, PASS.** A code-fence-aware Python resolver
walked every owned `*.md` (21 docs, excluding `dist/`, `node_modules/`, `tmp/`,
`report/`) and checked every relative link/image against
`os.path.normpath(os.path.join(os.path.dirname(doc), path.split('#')[0]))`:

```
docs scanned: 21
relative links checked (code-fence aware): 8
MISSES: 0
```

`LICENSE` exists and its MIT text matches `package.json` `"license":"MIT"` and
README's `[LICENSE](LICENSE)` link. `README.md`'s `../../SECURITY.md` resolves
to the real repo-root `SECURITY.md`. No badge claim is made. No link-integrity
failure.

### Per-doc scores

| Doc | Score | Deviations (concrete) + exact fix |
|-----|-------|-----------------------------------|
| `README.md` | **58** | C1 (priority-matrix presented as mounted in the table and in §Rollup — false vs artifact) and C2 ("Eighteen operations" vs 17 live commands). Template otherwise complete and strong (H1+value prop, Why, Install, runnable Quickstart with captured envelopes, 7 Key features, Envelope/Error-code tables, Configuration, Further docs, Footer w/ Contributing+License+Security). `gitContext` build-skew caveat present (good). **Fix:** revert the negative control so `priority-matrix` is genuinely mounted (then 18 is true), or delete the `priorityMatrix` row/claim and say "Seventeen operations"; either way make README match `--help`. Note the recalled high-cardinality rule (README must not inline the full >15-capability list) — the 18-row verb table is a Tier-3 list; move the exhaustive surface to `SKILL.md`/`docs/reference/` and keep a hero + module map. |
| `skill/SKILL.md` | **55** | C9 (embedded `--help` transcript stale — 14 verbs, omits the stats reads, yet called "the live schema"), C1 (§8 claims `priority-matrix` mounted), C2 (header "17 verbs" vs 16 live). Otherwise the canonical agent doc: calling convention, special commands, envelope + 9-code exit table, supersession semantics, filing hazards. **Fix:** re-capture the live `--help` verbatim after reverting the negative control, so the transcript and §1/§8 all agree with the artifact. |
| `SPEC.md` | **70** | C6 (stale "verified on npm" pins incl. a non-existent `sox-memory-core` dep), C8 (§6.7 mounted-surface list omits the stats reads). Two genuine fixes landed: `Status: PROPOSED` → `Status: IMPLEMENTED` (line 3) and the `view:"lookup"` surface corrected to the real `lookup --input '{"q":…}'` (diff at §3a/§5b). 2,993 lines, otherwise authoritative. **Fix:** refresh §0 pins to `package.json`; align §6.7 with §5/README/SKILL. |
| `CHANGELOG.md` | **50** | C3 ("14 verbs") and C4 (`1.0.0 (Unreleased)`). Also not Keep-a-Changelog per the recalled template: no `# Changelog` H1 + intro line, headings are the emoji nx-release shape (`### 🚀 Features` / `### 🩹 Fixes` / `### 📖 Documentation & tests` / `### ❤️ Thank You`) instead of the fixed `### Added/Changed/Deprecated/Removed/Fixed/Security`, and there is no `## [Unreleased]`. **Fix constraint:** repo `AGENTS.md` forbids hand-editing CHANGELOG — reconcile the verb count and release state through `nx release`/the graph, and either adopt the Keep-a-Changelog shape or record the accepted template deviation in `doc-ops.md`. |
| `DATA_MODEL.md` | **90** | Current; node/edge model matches `src/write/*` + `src/store/type-policy.ts`; §2 catalog table and §5 fixed edge table are exact. No contradiction found. |
| `DESIGN.md` | **63** | C7 (stale `Version: 0.2.0`; dependency block pins `^0.9.1`/`^0.9.1`/`^0.4.2`/`^0.4.1`/`^0.6.0` vs `package.json`). **Fix:** bump the stamp to the 1.0.0 line; re-sync the dep block. |
| `PLUGIN_ARCHITECTURE.md` | **90** | Exemplary: the historical note explicitly retracts the never-shipped plugin host and names the real seam (`write/bootstrap.ts`). No contradiction. |
| `RAG-SPEC.md` | **68** | C7 (`Version: 0.4.0`; §0 substrate pin "`@adhd/sox-graph-store` 0.6.0" vs `^0.10.1`). The shipped §1–§3 vs forward §4–§10 split is honest and good. **Fix:** bump the stamp; correct the substrate pin. |
| `CONTRIBUTING.md` | **64** | Honest top-of-file status callout (2026-09-24) that the `backlog-e2e-*` harness is absent, but the doc still contains **no runnable contributing path** — no `npx nx build/test/lint backlog`, no local dev setup. The entire body is design-for-an-absent-harness. **Fix:** add a short "Build / test / lint" section up front; keep the e2e strategy clearly fenced as intent. |
| `LICENSE` | **100** | MIT text present; matches `package.json` and README's link. (Not in `package.json` `files` — harmless, npm always ships LICENSE.) |
| `STATE.md` | **20** | C5 (hard: "mid-section A … nothing pushed or published" on a shipped 1.0.0). Stale rollout tracker. **Fix:** remove it, or re-stamp to the real 1.0.0 end-state. Cannot stay as written. |
| `BACKLOG_BACKLOG.md` | **15** | Self-declared *"This is not a tracked backlog … nothing here is authoritative state"* — a 714-line dead audit artifact in a repo whose graph is the source of truth. **Fix:** remove (file anything still live through `adhd-backlog`). |
| catalog `capabilities.json` | **50** | C1: `priority-matrix` entry's `verified_output` ("backlog priority-matrix …") and *"mounted verb listed in live --help (exit 0)"* are **not produced by the artifact** — a fabricated verification. `part-of-rollup`/`open-curve` are correctly re-derived (`cli+mcp+http+library`; both genuinely in `--help`). `last_verified_sha` equals HEAD but `verified_dist.note` admits the dist was *"rebuilt from an uncommitted working tree after HEAD"*. **Fix:** re-derive the `priority-matrix` entry against the reverted mount (or drop it), and re-verify against a committed dist. |
| catalog `metrics.md` | **45** | Has a `[BEFORE]`+`[AFTER]` pair (improvement), but `metric_1` 0→0 is unfalsifiable and falsified by `consumer.md`; `undocumented=0%` is not credible given the consumer's documented gaps; the `[AFTER]` note itself flags CHANGELOG as stale ("still says 14 verbs") without fixing it. **Fix:** record a *measured* metric_1 that is consistent with `consumer.md` (or fix the fallbacks and re-measure to 0). |
| catalog `doc-conformance.md` | **55** | Regenerated against the AFTER state and correctly credits the SPEC status/`view:"lookup"` fixes, but it still rates README and SKILL *"quality: none"* — false given C1/C9 — and reports UNDOCUMENTED ~0% while `consumer.md` documents real vocabulary gaps. **Fix:** regenerate after C1/C9 are resolved. |
| catalog `consumer.md` | **62** | Lens-3 artifact **now exists** (prior blocker cleared). But Task 3 gap #2 cites a `view:"lookup"` contradiction at `SPEC.md` §3a line 326 that the working tree has **already removed** (the diff replaces it with `lookup --input '{"q":…}'`), so the report describes a SPEC state that no longer exists; and it never exercises the (unmounted) stats verbs. **Fix:** re-run against the frozen surface. |

### Missing bundle docs

- **Local `AGENTS.md`** — the package has none (the recalled AGENTS.md template
  marks it required for a non-root scope); `doc-ops.md` logs it as
  "PROPOSED (not applied)". This is a documented deferral gated by the repo's own
  A/B-test rule, so it is noted, not the primary blocker.
- `consumer.md` and a fresh `[AFTER]` cartographer block — both now present.

---

## Lens 3 — consumer test

`docs/marketing/.catalog/consumer.md` exists and drives 3 canonical doc-only
tasks. Result: **1 of 3 complete, 2 of 3 PARTIAL.**

- **Task 1 (register project + file a bug with git context) — SUFFICIENT.** No
  source read required. Correctly flags that README's quickstart files with no
  component while warning the item then lands on `(root)` and is invisible to
  component-scoped queries.
- **Task 2 (list every open bug under a component, close one, state terminal
  requirements) — PARTIAL.** Terminal-transition mechanics are fully documented,
  but "list every open bug" is not answerable with confidence: **no doc
  enumerates the seeded `kind`/`status`/`priority` catalog values or the
  `status.terminal` flags** (so a reader cannot know whether `kind:"bug"` is
  valid or whether `toStatus:"closed"` is terminal), and the full `query.filter`
  key set lives only in `SPEC.md` §6.5 while the agent-facing `SKILL.md` claims
  to be the single source for the command surface. `consumer.md` marks the kind
  gap **HIGH** and reaches for source (`src/write/catalog.ts` seed rows).
- **Task 3 (resolve which project/component owns a file, then register it) —
  PARTIAL.** `lookup` only resolves already-registered locations, so "who owns
  this unregistered file?" is impossible doc-only (a design limitation the docs
  are honest about). The report's `view:"lookup"` contradiction is **stale** —
  the working tree already fixed it.

A doc-only newcomer cannot complete 2 of 3 canonical tasks; the "list/filter
open bugs" capability is **not fully usable from docs alone**, which is a
usability gap under the brief. Lens 3 = **FAIL (PARTIAL)** — and it directly
falsifies the `metric_1 = 0` claim in Lens 1.

---

## Required fixes (ordered)

**BLOCKING — process (do first; without these the loop cannot close):**

1. **Remove the un-reverted negative control.** Restore the `export` keyword on
   `priorityMatrix` in `src/api.ts:478-480` (the comment says it is meant to be
   *"reverted immediately"*) and add `priorityMatrix` back to `src/index.ts`'s
   export list so `server.verbs.spec.ts` is green again; then rebuild `dist/`.
   This is `DEBT-PROCESS-DISPATCH-RESIDUE-001`'s exact failure mode and is the
   root of C1/C2. (This also finishes the steward's intended "mounted surface"
   rewrite, which is currently only 2/3 landed.)
2. **Freeze one revision.** Commit the rewritten docs + `LICENSE` + the new
   `docs/marketing/.catalog/` and the reverted `src/`/`dist/` so docs, source,
   and binary describe one tree. Do not review docs that self-describe a
   revision they are not on.
3. **Re-run the cartographer on the frozen surface** and replace the `[AFTER]`
   block with a **measured** `metric_1_eliminated_reader_searches` that is
   consistent with `consumer.md` (0 is acceptable only once the consumer's
   fallbacks are actually eliminated), plus fresh `junk%`/`undocumented%`.
4. **Re-run doc-consumer** on the frozen surface and refresh `consumer.md`.

**BLOCKING — contradictions:**

5. **Resolve C1/C2 — the `priority-matrix` mount.** Prefer (a) revert the
   negative control (fix 1) so `priority-matrix` genuinely mounts, then make
   README ("Eighteen operations"), SKILL (§1 count + §8), SPEC §6.7, and
   `capabilities.json` all agree with the rebuilt `--help`. If instead the verb
   is meant to stay unmounted, delete it from the README table/§Rollup, SKILL
   §1/§8, and `capabilities.json`, and change the counts to 16 verbs/17
   operations. Whichever you choose, `capabilities.json`'s `priority-matrix`
   `verified_output` must be a value the artifact actually produces.
6. **Re-capture `SKILL.md` §1's embedded `--help` transcript (C9)** from the
   rebuilt binary so it matches the live schema it tells the reader to trust.
7. **Reconcile `CHANGELOG.md` (C3/C4)** — via `nx release`/the graph, not by
   hand — to 17 verbs + `batch` and to the real shipped 1.0.0 state (drop
   `(Unreleased)`).
8. **Reconcile `STATE.md` (C5)** — remove it or re-stamp to the real 1.0.0
   end-state. "Nothing pushed or published" cannot stand next to a shipped 1.0.0.
9. **Refresh the version pins (C6/C7)** to `package.json`: SPEC §0
   (`graph-store ^0.10.1`, `adapter ^0.9.2`, `hybrid-search ^0.4.6`,
   `embedding-provider ^0.5.3`, `vector-store ^0.7.0`; drop the
   `sox-memory-core@0.9.2` pin), DESIGN.md's dependency block, and RAG-SPEC §0's
   substrate pin; align SPEC §6.7's mounted-surface statement (C8).
10. **Bump `DESIGN.md` (`0.2.0`) and `RAG-SPEC.md` (`0.4.0`)** stamps to the
    1.0.0 line (keep RAG-SPEC's shipped-vs-forward split explicit).
11. **Close the docs-vs-vocabulary gap** the consumer found: enumerate the seeded
    `kind`/`status` (+ `terminal` flags)/`priority` catalog rows in `SKILL.md`
    (or a linked reference), and promote the `query.filter` key set out of
    `SPEC.md` §6.5 into the agent-facing surface.
12. **Add a runnable contributing path to `CONTRIBUTING.md`** (build/test/lint),
    keeping the absent `backlog-e2e-*` harness clearly marked as intent.
13. **Remove `BACKLOG_BACKLOG.md`** (self-declared non-authoritative) after
    filing anything still live through `adhd-backlog`.

**HOUSEKEEPING:**

14. Seed the local `AGENTS.md` (per the recalled template) once the A/B-test
    gate permits, and log it in `doc-ops.md`.

---

## Summary

| Lens | Status | Blocking? |
|------|--------|-----------|
| 1 — closed loop | `[AFTER]` block present, but `metric_1` 0→0 (no reduction, falsified by `consumer.md`); 9 hard contradictions (C1–C9) | **YES** |
| 2 — conformance | Link integrity PASS (resolver: 8 checked, 0 misses); LICENSE real; per-doc scores above; CHANGELOG template deviation; stale version pins | **YES** (C1–C9) |
| 3 — consumer test | `consumer.md` present; 1/3 tasks doc-only complete, 2/3 PARTIAL (kind vocabulary, filter keys, unregistered-file owner) | **YES** |

The prose remains genuinely strong — README and SKILL are among the best-written
docs in this repo, the envelope/error-code tables are exact, and
`PLUGIN_ARCHITECTURE.md` honestly retracts a design that never shipped. But the
gate is not a prose prize: an **un-reverted negative-control patch** in
`src/api.ts` means the built binary does not mount `priority-matrix`, while both
primary consumer docs **and** `capabilities.json` assert it does — including a
`verified_output` the artifact never produces. The closed loop was run but not
*closed* (its metric is contradicted by the consumer report), and 2 of 3
canonical tasks remain only partially usable from docs. **FAIL.** Apply the
ordered fixes, re-run the cartographer + consumer on a frozen revision, then
re-review.
