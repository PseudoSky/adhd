# release-readiness — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** search-cutover, plan-notes, fix-tripwire, fix-core-parsers, fix-core-lifecycle, fix-core-errors, release-gate-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py release-readiness`
**Executor:** executor=haiku tier=haiku · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every release gate of main that can run on the branch has run green on the fixed tree and its exit code is recorded against the merge-base with local main, sync-global is ready for the stealth-search bins, the release order (engine-runtime first, then the range bump) is recorded, and the new-package approval of AGENTS.md:25 names exactly the three approved packages in the format main expects.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/release-readiness.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Run and record (`EXIT <command>: <code>` in evidence/release-readiness.md): `pnpm check:release-ranges`, `pnpm release:dry`, the AGENTS.md affected gate, `node tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs`, `check-skip-expiry.mjs` and `check-lane-reachability.mjs`. Do not publish, do not push. The gate failures of the previous run are fixed upstream by `release-gate-fixes` (this state depends on it); re-run every gate fresh on the fixed tree and rewrite the evidence so it holds a single current record. [release-readiness.1]

- The affected gate uses LOCAL main, never the stale `origin/main` (AGENTS.md:37 is not edited): `npx nx affected --base=$(git merge-base HEAD main) --head=HEAD $(node .githooks/lib/pre-push-flags.mjs)`. Record the base on its own line, `BASE <sha>`, equal to `git merge-base HEAD main`, and show the `git merge-base HEAD main` expression in the evidence. [release-readiness.1]

- Release order (new): write `docs/plan/stealth-browser/release-readiness/release-order.md` with the numbered order (1) publish `@adhd/apigen-engine-runtime` first: the registry's 0.3.5 lacks `buildApigenPackage` while the worktree's 0.3.5 has it (`packages/apigen/apigen-engine-runtime/src/lib/build-apigen-package.ts`, re-exported from `src/index.ts`); evidence `docs/plan/stealth-browser/evidence/cutover/tarballs.json` (the `cutover-apigen-engine-runtime-0.3.5.tgz` tarball, kept under `~/.cache/adhd-dev-tarballs/`), `evidence/cutover/live-vs-recorded.md` line 7, and graph item `c4afebb0`; (2) bump `entrypoint/stealth-search`'s `@adhd/apigen-engine-runtime` range (today `^0.3.3`, which admits the broken registry 0.3.5, so the bump is mandatory) to the newly published version BEFORE publishing `@adhd/stealth-core-browser` and `@adhd/stealth-search`, then `pnpm check:release-ranges` must exit 0 after the bump. Record on their own `KEY: value` lines `REGISTRY-VERSION: 0.3.5`, `WORKTREE-VERSION:` (engine-runtime's package.json version), `CURRENT-RANGE:` (stealth-search's current range), `PLANNED-VERSION:` (the version the `release:dry` output shows for engine-runtime, which must be higher than the registry's) and `PLANNED-RANGE: ^<PLANNED-VERSION>`. Keep the engine-runtime lines of the `release:dry` output (the `bumping to` / `would write` lines) in `release-readiness/release-dry.log.md`; the guard cross-checks them. Put any README pointer in release-order.md (README.md belongs to plan-notes: do not edit it). Do not perform the bump or the publish. [release-readiness.5]

- sync-global readiness (PUBLISHING.md Step 3.5, `pnpm release:sync-global`): list the bins `stealth-search` and `stealth-search-mcp`, check for a pre-existing global shim that would end `legacy-pending`/`refused`, and record the expected outcome and the remedy in release-readiness/sync-global.md. Dry-run only.

- AGENTS.md:25 requires explicit human approval for every new package, recorded in the ticket or prompt: check APPROVAL-split.md, APPROVAL-tripwire.md, APPROVAL.md and APPROVALS.md name all three packages (@adhd/resilience-core-tripwire, @adhd/stealth-core-browser, @adhd/stealth-search) with the verbatim request and a date; fix the documents if one is missing, quoting the approvals already on record, never inventing one.

- Correct the superseded approval summaries: `APPROVAL.md` and `APPROVAL-tripwire.md` still approve `@adhd/stealth-browser` / `entrypoint/stealth-browser` and count 'exactly ONE' / 'exactly TWO' packages. Rewrite only the package table and summary (above the `## Human approval carried by the request` heading) so both name exactly `@adhd/stealth-search`, `@adhd/stealth-core-browser` and `@adhd/resilience-core-tripwire`, remove the stale name and count everywhere outside the human's double-quoted text, and add a line `Summary corrected 2026-10-23`. Every double-quoted segment of the human approval text stays byte-identical to `git show 6034633c6:<path>`; quote nothing new and invent no approval. [release-readiness.6]

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:release-readiness]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py release-readiness` runs every acceptance criterion below (red until the work is done); `--only release-readiness.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py release-readiness --only release-readiness.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [release-readiness.1] evidence/release-readiness.md records `EXIT <command>: <code>` for `pnpm check:release-ranges`, `pnpm release:dry`, the AGENTS.md affected gate (run as `npx nx affected --base=$(git merge-base HEAD main) --head=HEAD $(node .githooks/lib/pre-push-flags.mjs)`, with a `BASE <sha>` line equal to `git merge-base HEAD main`, local main and never the stale origin/main), check-test-wiring, check-skip-expiry and check-lane-reachability, and every code is 0.

- [release-readiness.2] release-readiness/sync-global.md names the bins stealth-search and stealth-search-mcp, the PUBLISHING.md Step 3.5 outcomes `refused`, `unverifiable` and `legacy-pending`, whether a pre-existing global shim exists, and the expected outcome.
- [release-readiness.3] The AGENTS.md:25 new-package approval is recorded for all three packages: APPROVAL-split.md, APPROVAL-tripwire.md and APPROVALS.md together name @adhd/resilience-core-tripwire, @adhd/stealth-core-browser and @adhd/stealth-search, each with the verbatim human request and a date.
- [release-readiness.4] Only owned paths changed by [psm:release-readiness] commits (release-readiness/, the APPROVAL documents).
- [release-readiness.5] release-readiness/release-order.md records the explicit release order: (1) publish @adhd/apigen-engine-runtime first (the registry's 0.3.5 lacks buildApigenPackage, the worktree's 0.3.5 has it; evidence/cutover/tarballs.json, cutover-apigen-engine-runtime-0.3.5.tgz, graph item c4afebb0), (2) bump entrypoint/stealth-search's @adhd/apigen-engine-runtime range to the new version before publishing @adhd/stealth-core-browser and @adhd/stealth-search, then `pnpm check:release-ranges` exits 0; REGISTRY-VERSION, WORKTREE-VERSION, CURRENT-RANGE, PLANNED-VERSION and PLANNED-RANGE lines agree with engine-runtime's package.json, stealth-search's package.json and the release:dry output recorded in release-readiness/, and buildApigenPackage exists in the worktree's engine-runtime source.
- [release-readiness.6] APPROVAL.md and APPROVAL-tripwire.md approve exactly @adhd/stealth-search, @adhd/stealth-core-browser and @adhd/resilience-core-tripwire in their summary: the superseded @adhd/stealth-browser name and the 'exactly ONE/TWO' count are gone outside the human's quoted text, a `Summary corrected 2026-10-23` line is present, and every double-quoted segment of the documents at 6034633c6 is byte-identical.
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/release-readiness/", "docs/plan/stealth-browser/APPROVAL-split.md", "docs/plan/stealth-browser/APPROVAL-tripwire.md", "docs/plan/stealth-browser/APPROVAL.md", "docs/plan/stealth-browser/APPROVALS.md", "docs/plan/stealth-browser/evidence/release-readiness.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/release-readiness.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:release-readiness]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=haiku tier=haiku; runs gates and records exit codes, documents the release order, corrects the approval summaries
