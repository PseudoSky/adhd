# main-merge — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** every completed leaf state (7) · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py main-merge`
**Executor:** executor=haiku tier=haiku · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The branch contains main (599 commits ahead at cce416273): a merge commit with main as a parent, the three conflicts resolved (workspace groups and tsconfig paths unioned, the lockfile regenerated from main's), the sox-service-proxy 0.6.0 registry resolution kept for stealth-core-browser, `pnpm install --frozen-lockfile` exits 0 and the three packages still build and typecheck.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/main-merge.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Commit or leave plan bookkeeping as is, then `git merge main` in the worktree (never rebase, never reset). Record `MAIN-SHA: <full sha of main merged>` in evidence/main-merge.md.

- .adhd/workspace.json: keep main's `policy` group and the branch's `resilience` and `stealth` groups, alphabetical between `environment` and `ui-react`. tsconfig.base.json: union main's `@adhd/policy-core-client`, `@adhd/policy`, `@adhd/apigen-plugin-policy` with the branch's `@adhd/resilience-core-tripwire`, `@adhd/stealth-core-browser`, `@adhd/stealth-search`, add the missing comma after main's last entry, and keep main's `.../apigen-engine-runtime/test/helpers/parity-harness.ts` path.

- pnpm-lock.yaml: never hand-merge. Take main's blob (the file equals main's), run `pnpm install --lockfile-only`, then `pnpm install`; the three new importers re-resolve from the registry and `@adhd/sox-service-proxy` resolves 0.6.x with an integrity hash ([inv:pnpm-only]). Do not mix unrelated dependency bumps (a lockfile rewrite can widen the release scope to ~69 projects).

- Read, do not edit: AGENTS.md (worktree rules; merging to main happens only through scripts/worktree-merge.sh, the dispatcher's step), docs/standards/testing.md, PUBLISHING.md. Never push, never touch the main checkout ([inv:no-main-writes]).

- Record in evidence/main-merge.md: `MAIN-SHA:`, the three resolutions, `EXIT pnpm install --frozen-lockfile: 0`, `EXIT nx run-many -t build,typecheck: 0`. This state blocks every other state of the 2026-10-23 amendment.

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:main-merge]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py main-merge` runs every acceptance criterion below (red until the work is done); `--only main-merge.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py main-merge --only main-merge.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [main-merge.1] HEAD contains a merge commit that has main's tip (the `MAIN-SHA:` recorded in evidence/main-merge.md, default `git rev-parse main`) as a parent, and that tip is an ancestor of HEAD.

- [main-merge.2] The conflicts are resolved by union: no conflict markers in .adhd/workspace.json, tsconfig.base.json or pnpm-lock.yaml; workspace.json parses and holds the groups policy, resilience and stealth; tsconfig.base.json paths hold @adhd/policy-core-client, @adhd/policy, @adhd/apigen-plugin-policy, @adhd/resilience-core-tripwire, @adhd/stealth-core-browser and @adhd/stealth-search and keeps main's parity-harness path.
---

## Reservations

```text
read_only:  []
mutates:    [".adhd/workspace.json", "tsconfig.base.json", "pnpm-lock.yaml", "package.json", "docs/plan/stealth-browser/evidence/main-merge.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/main-merge.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:main-merge]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=haiku tier=haiku; merge conflict union edits and a lockfile regeneration; depends on every completed leaf state so all completed owners are ancestors of the conform and fix states
