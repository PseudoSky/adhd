# sp-reaper-load-proof — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** port-fixes · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-reaper-load-proof`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Prove, before `chrome-lifecycle` is written, the riskiest unproven assumption of the single-pass lifecycle: the detached reaper child can load the BUILT package entry (`dist/index.js`) with `require`, from an unrelated working directory, with no top-level side effect, and the exact spawn form `process.execPath -e require(<dist>).lifecycle.runChromeReaper(JSON.parse(...))` works. If it does, `reaper-link.ts` pins that form. If it does not, the plan is amended with a `bin` entry owned by `surface-hosts` BEFORE any lifecycle code exists, so nothing is written one way and rewritten later.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/stealth-browser/smoke/reaper-load-proof.md` only (the evidence). Scratch copies live under `mkdtemp` in `os.tmpdir()` and are deleted; nothing under `entrypoint/stealth-browser` is modified.

- **Reference Pattern:** `entrypoint/stealth-browser/src/index.ts` and `vite.config.ts` (the build output being proven), `evidence/entrypoint-parity.*` (how the built entry is already loaded by earlier gates), and the spawn form in the Delta Spec below (`SPEC-single-pass-lifecycle.md` section 4.2).

- **Delta Spec:** (1) Run `pnpm nx run stealth-browser:build` and record `BUILD: nx run stealth-browser:build exit=0`. (2) From a cwd OUTSIDE the repository (`mkdtemp` under `os.tmpdir()`, record it as `LOAD-CWD: <path>`) run `node -e "const m=require(process.argv[1]); console.log(typeof m)" <abs>/entrypoint/stealth-browser/dist/index.js`; record `LOAD: exit=0 typeof=object`. The process must exit on its own: no CDP connection, no timer left behind. (3) Check that the bundle keeps `@adhd/sox-service-proxy` external (`EXTERNAL: yes` when `dist/index.js` requires it instead of inlining it; vite.config.ts already uses `externalizeRealDeps`). (4) In a SCRATCH copy of `dist/` (never the package source) add a stub `lifecycle.runChromeReaper` that prints a line and exits, then run the exact spawn form `process.execPath ['-e', 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))', <abs dist/index.js>, <json>]` with `stdio` ignored and `detached` true as the real link will; record `SPAWN: exit=0` and `VERDICT: entry-path-ok`. (5) If anything fails record `VERDICT: needs-bin` and an `ALTERNATIVE:` line naming the `bin` entry `surface-hosts` must own; the dispatcher then amends the plan before `chrome-lifecycle` starts. The state never edits package source, never starts Chrome and never touches port 9222.

- **Invariants:** [inv:live-chrome] [inv:greenfield] [inv:no-features-removed] (this state removes nothing). The scratch copy never leaves `os.tmpdir()`. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:sp-reaper-load-proof]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py sp-reaper-load-proof` — runs every acceptance criterion below (red until the work is done); `--only sp-reaper-load-proof.N` runs one. The file `docs/plan/stealth-browser/smoke/reaper-load-proof.md` is the only product; criteria .1-.3 read its labelled lines.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py sp-reaper-load-proof --only sp-reaper-load-proof.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [sp-reaper-load-proof.1] The built package entry loads the way the detached reaper will load it: smoke/reaper-load-proof.md records `BUILD: nx run stealth-browser:build exit=0`, `LOAD: exit=0 typeof=object` produced by `node -e "const m=require(process.argv[1]); console.log(typeof m)" <abs>/entrypoint/stealth-browser/dist/index.js` run from a cwd OUTSIDE the repository (`LOAD-CWD: <path>`), with no top-level side effect (the process exits on its own: no CDP connection, no timer left), and `EXTERNAL: yes` (dist requires @adhd/sox-service-proxy instead of inlining it).
- [sp-reaper-load-proof.2] The exact spawn form is proven against a STUB namespace and the verdict is pinned: the evidence records `SPAWN: exit=0` for `process.execPath ['-e', 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))', <abs dist/index.js>, <json>]` (stub `lifecycle.runChromeReaper` added only in a scratch copy: the package source is untouched) and `VERDICT: entry-path-ok`; if the verdict is `VERDICT: needs-bin` an `ALTERNATIVE:` line names the `bin` entry that surface-hosts must own and chrome-lifecycle uses instead (the plan is then amended before chrome-lifecycle starts).
- [sp-reaper-load-proof.3] Only owned paths changed by [psm:sp-reaper-load-proof] commits (the single evidence file); no file under entrypoint/stealth-browser is modified and no scratch artifact is left in the repository.

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/smoke/reaper-load-proof.md"]
```

---

## Contract Promise

Added: `docs/plan/stealth-browser/smoke/reaper-load-proof.md`. Nothing else is modified.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:sp-reaper-load-proof]`:

- [ ] After the evidence file is complete — commit: `docs(stealth-browser): reaper entry load proof [psm:sp-reaper-load-proof]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- `chrome-lifecycle` depends on this state through the DAG: it is the hold the dispatcher asked for ("unblock chrome-lifecycle and dependents once amended" is satisfied when this state is complete and the verdict is `entry-path-ok`).
- Labelled evidence lines are matched literally (`BUILD:`, `LOAD:`, `LOAD-CWD:`, `EXTERNAL:`, `SPAWN:`, `VERDICT:`); keep one per line.
- A missing built `dist/` means the build failed: fix nothing here, record the failure and the verdict `needs-bin` is NOT a substitute for a red build; report to the dispatcher.
