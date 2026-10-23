# release-readiness — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** search-cutover, plan-notes, fix-tripwire, fix-core-parsers, fix-core-lifecycle, fix-core-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py release-readiness`
**Executor:** executor=haiku tier=haiku · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every release gate of main that can run on the branch has run and its exit code is recorded, sync-global is ready for the stealth-search bins, and the new-package approval of AGENTS.md:25 is recorded for all three packages in the format main expects.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/release-readiness.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Run and record (`EXIT <command>: <code>` in evidence/release-readiness.md): `pnpm check:release-ranges`, `pnpm release:dry`, the AGENTS.md affected gate (`npx nx affected --base=origin/main --head=HEAD $(node .githooks/lib/pre-push-flags.mjs)`), `node tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs`, `check-skip-expiry.mjs` and `check-lane-reachability.mjs`. Do not publish, do not push.

- sync-global readiness (PUBLISHING.md Step 3.5, `pnpm release:sync-global`): list the bins `stealth-search` and `stealth-search-mcp`, check for a pre-existing global shim that would end `legacy-pending`/`refused`, and record the expected outcome and the remedy in release-readiness/sync-global.md. Dry-run only.

- AGENTS.md:25 requires explicit human approval for every new package, recorded in the ticket or prompt: check APPROVAL-split.md, APPROVAL-tripwire.md, APPROVAL.md and APPROVALS.md name all three packages (@adhd/resilience-core-tripwire, @adhd/stealth-core-browser, @adhd/stealth-search) with the verbatim request and a date; fix the documents if one is missing, quoting the approvals already on record, never inventing one.

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:release-readiness]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py release-readiness` runs every acceptance criterion below (red until the work is done); `--only release-readiness.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py release-readiness --only release-readiness.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

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

executor=haiku tier=haiku; runs gates and records exit codes
