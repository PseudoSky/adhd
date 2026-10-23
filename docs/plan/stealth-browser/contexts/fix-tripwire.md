# fix-tripwire — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-tripwire · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-tripwire`
**Executor:** executor=typescript-pro tier=sonnet/medium · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The tripwire package is deterministic and truthful: the expiry audit line writes reason `ttl-expired`, the interleaved-writers storage spec passes without wall-clock tuning, and guard tripwire-core.32 stops flaking.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-tripwire.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Backlog 84e1f7a2: the audit line written when a tripped entry expires must carry reason `ttl-expired`; convert the `it.fails` test in the audit spec into a passing `it` that reads the written line.

- storage.spec interleaved writers hit the 5 s default timeout under load. Make it deterministic: drive the interleaving with gates (promises resolved by the test) over `memory-fs`, no `setTimeout`, no sleeps, no raised timeout numbers. Then find what made `guard.py tripwire-core --only tripwire-core.32` flaky (it runs the package test lane under load) and record the root cause in evidence/fix-tripwire.md as `root cause: ...`.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-tripwire]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-tripwire` runs every acceptance criterion below (red until the work is done); `--only fix-tripwire.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-tripwire --only fix-tripwire.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-tripwire.1] (backlog 84e1f7a2) The expiry audit line is `ttl-expired`: `src/lib/audit.ts` (or the module that writes the line) names `ttl-expired`, a spec under test/unit simulates a tripped entry whose ttl has passed and asserts the written audit line's reason, titles carry `ttl-expired`, `audit` and `84e1f7a2`, the spec cites [fix-tripwire.1], no tripwire test uses `it.fails`, and the spec is green.

- [fix-tripwire.2] The interleaved-writers spec is deterministic: a storage spec cites [fix-tripwire.2], its titles carry `interleaved` and `deterministic`, it has no `setTimeout`, `sleep(` or numeric per-test timeout, and it passes in three consecutive uncached runs.
- [fix-tripwire.3] evidence/fix-tripwire.md names the root cause of the tripwire-core.32 flake (`root cause: ...`) and `guard.py tripwire-core --only tripwire-core.32` exits 0 three runs in a row.
- [fix-tripwire.4] evidence/fix-tripwire.md records the red-first proof: a `RED:` line with the failing assertion of each new spec on the untouched source and a `GREEN:` line with the passing run after the fix.
---

## Reservations

```text
read_only:  []
mutates:    ["packages/resilience/resilience-core-tripwire/", "docs/plan/stealth-browser/evidence/fix-tripwire.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-tripwire.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-tripwire]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium; backlog 84e1f7a2
