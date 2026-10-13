# tripwire-pack — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** tripwire-docs, port-fixes, sp-link · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-pack`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The package is release-ready and consumable before publication: every package gate is green and recorded, the consumer tarball is packed OUTSIDE every `.worktrees/` directory with its sha256 and the commit it was packed from, it loads from both a CommonJS `require` and an ES-module named import (R3), and the lockfile change is importer-only. The consumers (`agent-search-cutover`, `tripwire-reverse-migrate`) install this exact tarball.

---

## Semantic Distillation

- **Primitive:** MODIFY `packages/resilience/resilience-core-tripwire/package.json`, `packages/resilience/resilience-core-tripwire/project.json`, `packages/resilience/resilience-core-tripwire/vite.config.ts` only for release-hygiene fixes the gates demand; MODIFY `pnpm-lock.yaml` (importer block); CREATE `docs/plan/stealth-browser/evidence/tripwire/pack-gates.json` and `evidence/tripwire/tripwire-tarball.json`; the tarball itself lives outside the repository.

- **Reference Pattern:** `docs/plan/stealth-browser/evidence/` tarball records of the stealth-browser package (`agent-search-cutover.3` style: tarball path, sha256, packed_from_head); `docs/publishing/` pack and publish notes.

- **Delta Spec:** (1) Run `lint`, `typecheck`, `typecheck-spec`, `test`, `build` and `verify-dist-load` for `resilience-core-tripwire` and record every command with its exit code and the tripwire tree sha in `evidence/tripwire/pack-gates.json`. (2) `pnpm pack` (never `npm pack`) the built package into a directory OUTSIDE every `.worktrees/` (for example `/Users/nix/.cache/adhd-dev-tarballs/`), named `tripwire-0.1.0.tgz`; record `tarball`, `sha256`, `packed_from_head`, `packed_from_tree`, `pack_cmd` and the member list (`package/dist/index.js`, `package/dist/index.d.ts`, `package/package.json`, `package/README.md`, `package/CHANGELOG.md`, no `.mjs`) in `evidence/tripwire/tripwire-tarball.json`. (3) Extract into a scratch directory and prove a CJS `require` and an ES-module named import (`type: module` consumer: `createTripwire`, `CONFIRM_TOKEN`, `adhdDataDir`, `TripwireTrippedError`, `interactiveGate`, `runUnlockCli`) both succeed; record `esm_smoke: true`. (4) `pnpm install` through the plan's worktree install so the new workspace project appears as an importer in `pnpm-lock.yaml`; the diff may only ADD lines. This state depends on `sp-link` so the lockfile owners are serialized.

- **Invariants:** [inv:pnpm-only] [inv:one-new-package] ([def:tripwire-pkg]) [inv:greenfield]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-pack]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-pack` — runs every acceptance criterion below (red until the work is done); `--only tripwire-pack.N` runs one. All six `nx run resilience-core-tripwire:*` targets in .1; the tarball smoke in .3.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-pack --only tripwire-pack.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-pack.1] TW29 the package gates are green: `nx run resilience-core-tripwire:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` and `:verify-dist-load` all exit 0 (evidence/tripwire/pack-gates.json records every command with its exit code and the tripwire tree sha), the manifest has no `module`, `exports` or `type`, zero `dependencies`, no .mjs file is emitted and `verify-dist-load` executes the built entry.
- [tripwire-pack.2] The consumer tarball is recorded: evidence/tripwire/tripwire-tarball.json holds `tarball` (an absolute path outside every .worktrees/ directory, named tripwire-0.1.0.tgz), its `sha256`, `packed_from_head` (an ancestor of HEAD) and `packed_from_tree` (the tripwire tree sha at that commit), the `pack_cmd`, and the tarball lists package/dist/index.js, package/dist/index.d.ts, package/package.json, package/README.md and package/CHANGELOG.md and no .mjs member.
- [tripwire-pack.3] The tarball works for both consumer module systems (R3, named-export detection): extracted into a scratch directory, `require()` of package/dist/index.js and an ES-module `import { createTripwire, CONFIRM_TOKEN, adhdDataDir, TripwireTrippedError, interactiveGate, runUnlockCli } from` the same file (a `type: module` consumer) both succeed and expose the named exports; the recorded `esm_smoke` in evidence/tripwire/tripwire-tarball.json is true.
- [tripwire-pack.4] The lockfile change is importer-only: the [psm:tripwire-pack] commits touch pnpm-lock.yaml (if at all) without removing a single line, and only owned paths changed (pnpm-lock.yaml and evidence/tripwire/).

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/SPEC-tripwire.md"]
mutates:    ["pnpm-lock.yaml", "docs/plan/stealth-browser/evidence/tripwire/", "packages/resilience/resilience-core-tripwire/package.json", "packages/resilience/resilience-core-tripwire/project.json", "packages/resilience/resilience-core-tripwire/vite.config.ts"]
```

---

## Contract Promise

Added: `evidence/tripwire/pack-gates.json`, `evidence/tripwire/tripwire-tarball.json`, the tarball (outside the repository). Modified: `pnpm-lock.yaml` (additions only).

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-pack]`:

- [ ] After the gates and the tarball — commit: `build(resilience-core-tripwire): pack the 0.1.0 consumer tarball [psm:tripwire-pack]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Consumers verify against this tarball; `packed_from_head` must be an ancestor of HEAD, so pack AFTER the last code commit and do not amend afterwards.
- A package fix needed to pass a gate belongs to the earlier state's files; the owned set here lists only the manifest, project and vite config for release-hygiene fixes. Report anything else.
