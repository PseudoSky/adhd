# prod-publish-readiness — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** prod-examples · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-publish-readiness`
**Executor:** `platform-engineer` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

**Origin:** inserted by `productization-hold` from `PRODUCT-REVIEW.md`; criteria carry the review's PA ids in their text.

---

## Goal

The package is publishable from `dist/` the way PUBLISHING.md requires: complete metadata, a 0.x version with a stated stability policy, a tarball that contains README.md, CHANGELOG.md, the bins and every exports target, executable bins with shebangs, and no private or unpublished `@adhd/*` dependency. The release decision itself stays with the dispatcher at `merge-readiness`. (Source: PRODUCT-REVIEW.md P10.)

---

## Semantic Distillation

- **Primitive:** MODIFY `entrypoint/stealth-browser/package.json` (metadata only); CREATE `docs/plan/stealth-browser/evidence/publish-dry-run.txt`.

- **Reference Pattern:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/PUBLISHING.md` (publish-from-dist, assets + dist-manifest targets), `entrypoint/dispatch-cli/package.json` and `entrypoint/backlog/package.json` (publishConfig, files, keywords).

- **Delta Spec:** Complete the package.json metadata (`description`, `keywords`, `license`, `publishConfig.access: public`, `files`, `engines.node: >=22.5`); keep the version 0.x. Build dist with the `nx` targets (`build`, `build-bin`, `assets`, `dist-manifest`), run `npm pack --dry-run --json` in `dist/`, and record its output in `evidence/publish-dry-run.txt`. Fix missing tarball members through the nx assets/manifest config, not by copying files by hand. Do NOT run `npm publish`, `version` or `pnpm release`: no release action is taken here. Placement: this state runs after `prod-examples` and before `tests-e2e`, so it is an ancestor of `gates-first` (`productization-hold.3`) and the e2e/gates run against the final package metadata and bins. The README at this point is the generator/baseline one; the final README and CHANGELOG are re-verified in the tarball by `audit-final.10` after the docs states, and the README stability policy is `readme-rewrite.8`.

- **Invariants:** [inv:pnpm-only] [inv:no-main-writes]; metadata fields only in package.json (no dependency edits: `deps-install` owns dependencies); never publish. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:prod-publish-readiness]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-publish-readiness` — runs every acceptance criterion below (red until the work is done); `--only prod-publish-readiness.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py prod-publish-readiness --only prod-publish-readiness.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [prod-publish-readiness.1] (PA10.1) package.json has description, keywords, license, publishConfig.access = public (matching dispatch-cli and backlog), files, and engines.node >= 22.5.

- [prod-publish-readiness.2] (PA10.2) The initial version is 0.x (the README's stability policy is guarded by readme-rewrite.8, which runs after the docs states).
- [prod-publish-readiness.3] (PA10.3) `npm pack --dry-run` against the built dist output lists README.md, CHANGELOG.md, bin/cli.js, bin/mcp.js and every exports target; the output is recorded in evidence/publish-dry-run.txt.
- [prod-publish-readiness.4] (PA10.4) dist/bin/cli.js and dist/bin/mcp.js start with a shebang and are executable.
- [prod-publish-readiness.5] (PA10.5) Every @adhd/* dependency is either a public workspace package (not private) or recorded as published in published-state.json.
- [prod-publish-readiness.6] Only owned paths changed by [psm:prod-publish-readiness] commits.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/README.md", "entrypoint/stealth-browser/CHANGELOG.md", "entrypoint/stealth-browser/dist/", "PUBLISHING.md"]
mutates:    ["docs/plan/stealth-browser/evidence/publish-dry-run.txt", "entrypoint/stealth-browser/package.json"]
```

---

## Contract Promise

Added: `docs/plan/stealth-browser/evidence/publish-dry-run.txt`. Modified: `entrypoint/stealth-browser/package.json` (metadata). Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:prod-publish-readiness]`:

- [ ] After the dry-run evidence -- commit: `chore(stealth-browser): publish readiness metadata [psm:prod-publish-readiness]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Placement deviation from PRODUCT-REVIEW.md P10 ("after readme-rewrite"): moved upstream so every prod-* state is an ancestor of `gates-first`; the part that needs the final docs is `audit-final.10`.
- The shebang/executable bit (PA10.4) comes from the build (`bin/*.ts` shim shebang plus the build-bin step); fix it in the build config if a gate shows otherwise.
