# tripwire-reverse-relink — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** merge-readiness, tripwire-reverse-migrate · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-reverse-relink`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

After the release, switch reverse-apis from the tarball to the registry range, re-run the verification on the registry build, fast-forward `feat/tripwire-adopt` into reverse main and remove the worktree and branch. Dispatcher-gated like `agent-search-relink`.

---

## Semantic Distillation

- **Primitive:** MODIFY the reverse worktree's `package.json` and `pnpm-lock.yaml`; CREATE `docs/plan/stealth-browser/tripwire-reverse/relink-verify.json`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/consumer-relink.md` (the same dispatcher gate and evidence style); the spec section 5.4 steps 3-4.

- **Delta Spec:** Preconditions: `merge-readiness` is complete, the dispatcher has run the release and `npm view @adhd/resilience-core-tripwire@0.1.0 version` exits 0 (record it). In the reverse worktree run `pnpm add @adhd/resilience-core-tripwire@^0.1.0` (replacing the extracted tarball directory), commit `package.json` and `pnpm-lock.yaml` by explicit path, re-run the four verification commands of `tripwire-reverse-migrate.4` and record them with `head` in `relink-verify.json`, then fast-forward merge `feat/tripwire-adopt` into reverse main (`git merge --ff-only`), record `merged_sha`, remove the worktree `.worktrees/tripwire-adopt` and delete the branch. Never push (no remote). Do not touch main's dirty files.

- **Invariants:** [inv:scratch-local-only] [inv:no-ai-attribution] [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-reverse-relink]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-reverse-relink` — runs every acceptance criterion below (red until the work is done); `--only tripwire-reverse-relink.N` runs one. The four recorded verification commands (.2) and the git state (.3).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-reverse-relink --only tripwire-reverse-relink.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-reverse-relink.1] The dependency resolves from the registry: `npm view @adhd/resilience-core-tripwire@0.1.0 version` is recorded with exit 0 in tripwire-reverse/relink-verify.json, the reverse worktree's package.json depends on `^0.1.0`, and its pnpm-lock.yaml resolves @adhd/resilience-core-tripwire with an integrity hash and no `tarball:` / `file:` resolution.
- [tripwire-reverse-relink.2] The verification is re-run on the registry build: relink-verify.json holds `head` equal to the worktree HEAD and exit 0 for the same four commands as tripwire-reverse-migrate.4 (request-builder tests, run-many lint,test,build, e2e-tests, the unlock spec).
- [tripwire-reverse-relink.3] The branch is merged fast-forward and cleaned: relink-verify.json records `merged_sha`, that commit is an ancestor of reverse-apis main, `feat/tripwire-adopt` no longer exists and the worktree .worktrees/tripwire-adopt is removed; the [psm:tripwire-reverse-relink] commits touched only package.json and pnpm-lock.yaml.

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/tripwire-reverse/reverse-verify.json"]
mutates:    ["/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/package.json", "/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/pnpm-lock.yaml", "docs/plan/stealth-browser/tripwire-reverse/"]
```

---

## Contract Promise

Modified: reverse `package.json` and `pnpm-lock.yaml`; reverse main fast-forwarded. Added: `tripwire-reverse/relink-verify.json`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-reverse-relink]`:

- [ ] After the registry dependency and a green re-run — commit in the reverse worktree: `build: depend on @adhd/resilience-core-tripwire ^0.1.0 from the registry [psm:tripwire-reverse-relink]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- A non-fast-forward merge means reverse main moved: rebase the branch in its worktree, re-run the verification, then merge; never force.
- This state is human-gated through `hb-release-decision`; do not run it before the release exists.
