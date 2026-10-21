# tripwire-reverse-migrate — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-reverse-migrate`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Consumers 1 and 2 adopt the package in reverse-apis (the request-builder gate and the unlock tool, plus reverse-auth, the api packages, the e2e harness and REARCHITECTURE section 12), in an isolated worktree, against the packed tarball, with the whole regression bar green and main's dirty files untouched.

---

## Semantic Distillation

- **Primitive:** Work in the reverse worktree `/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt` (branch `feat/tripwire-adopt`): the file list of spec section 5.1. Also append `.worktrees/` to `/Users/nix/dev/projects/reverse-apis/.git/info/exclude` (a local untracked file) and record `docs/plan/stealth-browser/tripwire-reverse/{main-status-before.txt,reverse-verify.json}`.

- **Reference Pattern:** The tripwire spec `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tripwire-spec.md` section 5.1 (every file, line range and the behavior changes); `evidence/tripwire/tripwire-tarball.json` (the artifact to install); `/Users/nix/dev/projects/reverse-apis/REARCHITECTURE.md` section 12.

- **Delta Spec:** Before anything else snapshot main: `git -C /Users/nix/dev/projects/reverse-apis status --porcelain > tripwire-reverse/main-status-before.txt`; create the worktree with `git worktree add /Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt -b feat/tripwire-adopt` after excluding `.worktrees/`. Install the tarball into the worktree's `node_modules/@adhd/resilience-core-tripwire` as a REAL directory (extract it; not a symlink, not a link into `.worktrees/`), add the root dependency `@adhd/resilience-core-tripwire` `^0.1.0` to `package.json` and DO NOT commit `pnpm-lock.yaml` (reverse CI uses `--frozen-lockfile`; the lockfile changes only at `tripwire-reverse-relink`). Then: delete `request-builder/src/lib/tripwire.ts`; create `request-tripwire.ts` (`createRequestTripwire({tripwireDir?})`, namespace `request-builder`, no expiry, `confirm-token`, `RequestTripContext {lastStatus, lastOperationId, method?, host?}`, state dir `tripwireDir ?? ADHD_REVERSE_HOME data ?? adhdDataDir(['reverse','data'], process.env)` so the layout `<root>/tripwire/<client>.lock` and the shared `audit.log` and the e2e harness's `ADHD_HOME` isolation hold); `send.ts` gates with `assertOpen` and trips with `trip` then throws `TripwireTrippedError.fromRecord(r.record, {responseStatus, responseBody})` (the 5xx path and the `recordSend` order are unchanged); `types.ts` `tripwirePath` becomes `tripwireDir` and `TripwireLockFile` is deleted; `index.ts` re-exports; the spec uses `createRequestTripwire({tripwireDir})` and adds block-count, audit and corrupt-lock tests; `vite.config.ts` lists the package in `external`; `tools/unlock-tripwire/unlock-tripwire.ts` becomes the ~15-line `runUnlockCli` call reading `TRIPWIRE_DIR` (its spec keeps the four spawn assertions and exit codes); `reverse-auth.ts` uses `read` and `clear` (`method: 'programmatic-confirm'`, `confirm: CONFIRM_TOKEN`); the tinder/rappi `build-request.ts`, the four `auth-config.ts` (typed `responseStatus`), the generator template, `harness.ts` `readTripwireLock` (`record.context.lastStatus`), the pacing and sequencing e2e scenarios, `REARCHITECTURE.md` section 12 (the shipped design, no historical commentary). Run `pnpm nx test request-builder`, `pnpm nx run-many -t lint,test,build`, `pnpm nx e2e e2e-tests` and `pnpm vitest run --config tools/unlock-tripwire/vite.config.ts` and record every command with its exit code and the worktree HEAD in `tripwire-reverse/reverse-verify.json` (`tools/unlock-tripwire` has no project.json, so its spec is run explicitly). Re-read each file before editing: line numbers are as of 2026-10-12.

- **Invariants:** [inv:greenfield] [inv:no-features-removed] [inv:tests-cite] [inv:scratch-local-only] (reverse-apis has no remote: never push). Behavior changes the reverse users will see are deliberate (D3): blocked sends are counted and audited, every trip and clear is audited, a corrupt lock blocks, a second 4xx keeps the first record. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-reverse-migrate]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-reverse-migrate` — runs every acceptance criterion below (red until the work is done); `--only tripwire-reverse-migrate.N` runs one. `guard.py tripwire-reverse-migrate` reads the recorded command exits (.4) and re-checks the repository state (.1-.3, .5, .6).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-reverse-migrate --only tripwire-reverse-migrate.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-reverse-migrate.1] The adoption branch is isolated: /Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt is a worktree on branch `feat/tripwire-adopt`, `.worktrees/` is listed in the main checkout's .git/info/exclude (a local untracked file), a non-empty snapshot of the main checkout's `git status --porcelain` was taken before the state started (docs/plan/stealth-browser/tripwire-reverse/main-status-before.txt), nothing is staged in the main checkout, the main branch carries no [psm:tripwire-reverse-migrate] commit, and no plan-tagged commit of the adoption branch changes a file the snapshot listed as dirty (other agents may edit the main working tree concurrently, so the check is commit- and index-scoped, not a whole-status comparison; criterion 6 owns the allowed exceptions).
- [tripwire-reverse-migrate.2] The migration is complete: packages/system/request-builder/src/lib/tripwire.ts is deleted and request-tripwire.ts exists (it imports @adhd/resilience-core-tripwire, namespace `request-builder`, `confirm-token` policy, no expiry), send.ts gates through `assertOpen` and trips through `trip` then throws `TripwireTrippedError.fromRecord`, tools/unlock-tripwire/unlock-tripwire.ts calls `runUnlockCli` and reads `TRIPWIRE_DIR`, tools/reverse-auth/reverse-auth.ts uses `read` and `clear` of the package, the request-builder vite.config.ts lists the package in `external`, the root package.json depends on `@adhd/resilience-core-tripwire` `^0.1.0`, and `rg` for TripwireLockFile, defaultTripwirePath, isTripwireTripped, unlockTripwire and tripwirePath over *.ts returns nothing.
- [tripwire-reverse-migrate.3] The consumer runs the tarball build: the worktree's node_modules/@adhd/resilience-core-tripwire is a real directory (not a symlink, not a link into .worktrees/) whose dist/index.js is byte-identical to the member of the tarball recorded by tripwire-pack, and the worktree's pnpm-lock.yaml is identical to main's (the lockfile changes only at relink, because reverse CI uses --frozen-lockfile).
- [tripwire-reverse-migrate.4] The regression bar is recorded for the current worktree head and scoped to the projects this state touched: docs/plan/stealth-browser/tripwire-reverse/reverse-verify.json holds `head` equal to the worktree HEAD and `commands` with exit 0 for `pnpm nx test request-builder` (the request-builder tests plus the new block-count, audit and corrupt-lock tests), `pnpm nx run-many -t lint,test,build -p request-builder` (lint, test and build of the touched library project) and `pnpm vitest run --config tools/unlock-tripwire/vite.config.ts` (the unlock tool's spawn assertions with their exit codes unchanged). The whole-workspace `pnpm nx run-many -t lint,test,build` and `pnpm nx e2e e2e-tests` runs are recorded as well but fail on the clean base commit d959c6a for reasons this change does not touch (lint of 14 projects, wingman-bridge tests, tinder e2e; filed separately in the reverse-apis backlog), so they are judged only as regression-free: every failed task at head also appears in the recorded `baseline` failed tasks.
- [tripwire-reverse-migrate.5] The specs and docs carry the change: request-builder.spec.ts uses `createRequestTripwire({ tripwireDir })`, asserts the `<root>/tripwire/tinder.lock` layout, a blocked-count with the `tripwire-gate-blocked` audit line, and that a corrupt lock blocks; new or changed specs cite ticket 8468f7b1 and a tripwire-reverse-migrate.N or TW id; REARCHITECTURE.md section 12 describes the shipped design (key and lock layout, blockedCount, audit events, `confirm-token` policy) without historical commentary; the e2e harness reads the lock through `record.context.lastStatus`; the generator template emits `tripwireDir`.
- [tripwire-reverse-migrate.6] Commit hygiene across repositories: [psm:tripwire-reverse-migrate] commits in the reverse worktree touch only files under packages/system/request-builder, packages/system/e2e-tests, packages/apis, tools/unlock-tripwire, tools/reverse-auth, tools/generators/api-package, REARCHITECTURE.md and package.json (never pnpm-lock.yaml or main's dirty files: AGENTS.md, captures.db, fatal.csv, identity/), and none was pushed (reverse-apis has no remote).

---

## Reservations

```text
read_only:  ["packages/resilience/resilience-core-tripwire/", "docs/plan/stealth-browser/evidence/tripwire/tripwire-tarball.json"]
mutates:    ["/Users/nix/dev/projects/reverse-apis/.worktrees/tripwire-adopt/", "/Users/nix/dev/projects/reverse-apis/.git/info/exclude", "docs/plan/stealth-browser/tripwire-reverse/"]
```

---

## Contract Promise

Modified: the reverse worktree only (committed on `feat/tripwire-adopt`, never merged here). Added: `tripwire-reverse/main-status-before.txt` and `reverse-verify.json` in this plan. Main's checkout is unchanged.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-reverse-migrate]`:

- [ ] After the worktree, the tarball install and the request-builder migration — commit in the reverse worktree: `feat(request-builder): adopt the tripwire package [psm:tripwire-reverse-migrate]`
- [ ] After the unlock tool, reverse-auth, api packages, e2e harness, docs and a green verification — commit in the reverse worktree: `feat: adopt the tripwire package in tools, apis and e2e [psm:tripwire-reverse-migrate]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Two repositories are involved: plan files are committed in the adhd worktree by explicit path; reverse-apis commits are made in its worktree by explicit path, tagged `[psm:tripwire-reverse-migrate]`, never `git add -A`, never touching main's dirty files (`AGENTS.md`, `captures.db`, `fatal.csv`, `identity/`).
- The evidence directory is `tripwire-reverse/` (not `evidence/tripwire/`) so this state is never concurrent with an owner of `evidence/` as a tree.
- Do not publish or push anything; the merge into reverse main is `tripwire-reverse-relink`.
