# plan-notes — WORK STATE

**Phase:** docs · **Kind:** work · **Depends on:** main-merge · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py plan-notes`
**Executor:** executor=haiku tier=haiku · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The plan README records what the plan cannot fix itself: the untagged core-seam .8 change, the plan-tooling bugs filed upstream, and the amendment's decisions.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/plan-notes.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Add a `## Known issues` list to docs/plan/stealth-browser/README.md: (1) core-seam .8 sits untagged inside commit aa5df30a; history cannot be rewritten, no action beyond this note. (2) compile-task.js truncates piped output at 64 KiB (plan-tooling bug in the sox plugin cache; the dispatcher files it upstream; do NOT edit the plugin cache). (3) plan-scaffold commits with --no-verify (same). (4) plan-scaffold has no verb to add a dependency edge to an existing state, so the 2026-10-23 amendment re-ran add-state on tracing-log-validation and audit-pre-review and restored their contexts. (5) the test layout of main moved the packages' tests from src/test to test; completed states keep their historical wording and their guards resolve the new locations.

- Add an `## Amendment 2026-10-23` paragraph naming the new states in wave order (main-merge; the three conform states; the fix states; search-mcp-iserror; fix-search-build; search-tracing-fixes; tracing-log-validation re-run; search-cutover; release-readiness; audit-pre-review) and the provisional OD-11 resolution (see OPEN-DECISIONS.md).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:plan-notes]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py plan-notes` runs every acceptance criterion below (red until the work is done); `--only plan-notes.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py plan-notes --only plan-notes.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [plan-notes.1] README.md has a `Known issues` section naming core-seam .8 and commit aa5df30a (untagged, history not rewritten), compile-task.js truncating piped output at 64 KiB, plan-scaffold committing with --no-verify, and the missing add-dependency verb.

- [plan-notes.2] README.md has an `Amendment 2026-10-23` paragraph that names main-merge, conform-tripwire, conform-core, conform-search, search-mcp-iserror, search-tracing-fixes and release-readiness, and the plugin cache was not edited (no change under ~/.claude/plugins in the evidence).
- [plan-notes.3] Only owned paths changed by [psm:plan-notes] commits (README.md).
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/README.md", "docs/plan/stealth-browser/evidence/plan-notes.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/plan-notes.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:plan-notes]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=haiku tier=haiku; documentation only
