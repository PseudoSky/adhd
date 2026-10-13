# deps-install — WORK STATE

**Phase:** scaffold · **Kind:** work · **Depends on:** entrypoint-parity · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py deps-install`
**Executor:** `platform-engineer` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

> **PREREQUISITE — human action required.** This state depends on `hb-deps-approval` from `human-blockers.json`. Before starting, verify:
>
> ```bash
> python3 docs/plan/stealth-browser/scripts/guard.py deps-install --only deps-install.1
> ```
>
> If it fails, **halt this state as `blocked` (not `failed`) and surface the blocker to the human.** Do not work around it.

---

## Goal

The three third-party libraries the parsers need (`node-html-parser`, `xpath`, `@xmldom/xmldom`) are declared in the new package at the source's version ranges, the lockfile has the new importer with no collateral version bumps, and the worktree has its own real node_modules so no later state can touch the main checkout.

---

## Semantic Distillation

- **Primitive:** MODIFY `entrypoint/stealth-browser/package.json`, `pnpm-lock.yaml` and `entrypoint/stealth-browser/eslint.config.mjs`; REPLACE the worktree node_modules symlink with a real install.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/package.json` (dependency ranges), `/Users/nix/dev/ai/scratch/agent-browser/adhd/parsers.ts:17-26` (the only third-party imports in the runner).

- **Delta Spec:** Precondition: `docs/plan/stealth-browser/APPROVALS.md` contains `DEP-APPROVAL: granted` and names the three packages (human-blocker hb-deps-approval; the scratch repo's `adhd/` had NONE of these declared, they are new to the workspace package). Then: remove the `node_modules` symlink; `pnpm install --frozen-lockfile=false --filter @adhd/stealth-browser...` is NOT used -- instead `pnpm add --filter @adhd/stealth-browser node-html-parser@^8.0.4 xpath@^0.0.34 @xmldom/xmldom@^0.9.10` from the worktree root with the pinned store (`pnpm config get store-dir` -> ~/Library/pnpm/store). Verify `git diff pnpm-lock.yaml` has zero removed lines. pnpm hoists the three packages into the worktree-ROOT `node_modules` (a real directory); there is no per-package `entrypoint/stealth-browser/node_modules`. Because no source imports them yet, the pre-commit `@nx/dependency-checks` lint would reject the dependency commit ("package is not used by stealth-browser"); hooks are never bypassed, so add to the `@nx/dependency-checks` options in `entrypoint/stealth-browser/eslint.config.mjs` `ignoredDependencies: ["node-html-parser", "xpath", "@xmldom/xmldom"]`, preceded by a comment containing the exact marker `TEMPORARY(stealth-browser:deps-install)` stating that `mig-capture-parsers` removes it once `parsers.ts` imports them.

- **Invariants:** pnpm only ([inv:pnpm-only]); main checkout node_modules untouched ([inv:no-main-writes]); the only lockfile change is the new importer block plus any newly-resolved packages. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:deps-install]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py deps-install` — runs every acceptance criterion below (red until the work is done); `--only deps-install.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py deps-install --only deps-install.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [deps-install.1] APPROVALS.md contains `DEP-APPROVAL: granted` naming node-html-parser, xpath and @xmldom/xmldom (human-blocker HB-DEPS).
- [deps-install.2] package.json dependencies pin exactly the three source ranges (node-html-parser ^8.0.4, xpath ^0.0.34, @xmldom/xmldom ^0.9.10).
- [deps-install.3] pnpm-lock.yaml has an importers entry for entrypoint/stealth-browser listing all three deps.
- [deps-install.4] The lockfile diff removes no existing line (no collateral version bumps): the pnpm-lock.yaml diff of this state's own [psm:deps-install] commits has zero '-' lines (later states' lockfile changes are their own guards' concern).
- [deps-install.5] The worktree-root node_modules is a real directory (not a symlink) and each of the three deps resolves, by real Node ESM resolution run from entrypoint/stealth-browser, to a path inside this worktree (never the main checkout).
- [deps-install.6] Main checkout node_modules untouched (.modules.yaml mtime == stamp) and only owned paths changed.
- [deps-install.7] Historical one-shot: the dependency commit carried the documented TEMPORARY `@nx/dependency-checks` `ignoredDependencies` entry (git history shows a [psm:deps-install] commit that introduced the marker); mig-capture-parsers.6 removed it again, so the live eslint config is not asserted.

---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/package.json"]
mutates:    ["entrypoint/stealth-browser/package.json", "pnpm-lock.yaml", "entrypoint/stealth-browser/eslint.config.mjs", "docs/plan/stealth-browser/APPROVALS.md"]
```

---

## Contract Promise

Added: three dependencies in package.json, importer block in pnpm-lock.yaml, real node_modules, a TEMPORARY `ignoredDependencies` entry in eslint.config.mjs. Modified: none. Deleted: node_modules symlink.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:deps-install]`:

- [ ] After APPROVALS.md is verified -- no commit needed (human-provided)
- [ ] After the install and the eslint entry -- commit `entrypoint/stealth-browser/package.json`, `pnpm-lock.yaml` and `entrypoint/stealth-browser/eslint.config.mjs` by explicit path (pre-commit hooks run; never `--no-verify`): `feat(stealth-browser): declare parser dependencies [psm:deps-install]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- If the lockfile diff shows removed lines, a version drifted: `git restore pnpm-lock.yaml entrypoint/stealth-browser/package.json`, then retry pinned. Do not commit a drifted lockfile.
- Never `pnpm install` while `node_modules` is still the symlink -- remove the link first (guard checks the main `.modules.yaml` mtime stamp).
- A real install in a worktree can take minutes; budget one session.
