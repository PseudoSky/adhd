# fix-core-parsers — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-parsers`
**Executor:** executor=typescript-pro tier=sonnet/medium · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

extractSnippet returns the snippet of the card it was asked about: on a result list of short cards the 500-character window never takes the previous card's snippet.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-core-parsers.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- `src/lib/parsers.ts` extractSnippet (lines ~349-358): the 500-char window starts before the card and, when the card text is short, includes the previous card's snippet. Simulate the report: a rendered list of 12 short cards (each snippet under 40 characters) where every card's window reaches into its predecessor; assert each card returns exactly its own snippet, the first card has no predecessor, and a long card still truncates at the window.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-core-parsers]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-core-parsers` runs every acceptance criterion below (red until the work is done); `--only fix-core-parsers.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-core-parsers --only fix-core-parsers.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["packages/stealth/stealth-core-browser/src/lib/parsers.ts", "packages/stealth/stealth-core-browser/test/unit/parsers/", "packages/stealth/stealth-core-browser/test/fixtures/parsers/", "packages/stealth/stealth-core-browser/test/helpers/parsers/", "docs/plan/stealth-browser/evidence/fix-core-parsers.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-core-parsers.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-core-parsers]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
