# tripwire-docs — WORK STATE

**Phase:** docs · **Kind:** work · **Depends on:** tripwire-interactive · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-docs`
**Executor:** `typescript-pro` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The package is documented for the three consumers and for an operator at 3 a.m.: README with install and three recipes, the error-code reference, the recovery runbook (break-glass `rm`, audit reading, sidecars), the 0.1.0 changelog and JSDoc on every export; the README examples are compiled and run as a spec so the docs cannot drift.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/resilience/resilience-core-tripwire/README.md`, `packages/resilience/resilience-core-tripwire/CHANGELOG.md`, `packages/resilience/resilience-core-tripwire/docs/ERRORS.md`, `packages/resilience/resilience-core-tripwire/docs/RECOVERY.md`, `packages/resilience/resilience-core-tripwire/src/test/unit/readme-examples.spec.ts`; add JSDoc to exported symbols under `packages/resilience/resilience-core-tripwire/src/lib/` (comment-only edits; the owned set lists README, CHANGELOG, docs and the spec, so JSDoc edits are committed in the same state with the code files they annotate listed in the commit).

- **Reference Pattern:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/stealth-browser/README.md` (house README skeleton: tagline, install, quick start, API, errors); `docs/contributing/conventions/` documentation rules; the spec section 4 closing paragraph (Docs).

- **Delta Spec:** README: install, the three recipes (a gate in a request pipeline with `assertOpen` and `trip`; a HITL gate in a CLI with `interactiveGate`; an unlock bin in five lines with `runUnlockCli` and `nodeTripwireIo`), the `stateDir` / `ADHD_HOME` explanation, the two clear policies (`confirm-token`, `open`), redaction, the local-disk (not NFS) caveat and the fail-closed rule. `docs/ERRORS.md`: every code of `errors.ts` with class, cause and remediation. `docs/RECOVERY.md`: the break-glass `rm <stateDir>/tripwire/<key>.lock`, the `.blocked` and `.cleared` sidecars, reading the NDJSON audit log, the unlock bin. CHANGELOG `0.1.0`. Each README fenced `ts` block is copied into `readme-examples.spec.ts` as one test against the memory fs. No document carries an AI attribution line ([inv:no-ai-attribution]).

- **Invariants:** [inv:one-new-package] ([def:tripwire-pkg]) [inv:greenfield] [inv:tests-cite] [inv:no-ai-attribution]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-docs]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-docs` — runs every acceptance criterion below (red until the work is done); `--only tripwire-docs.N` runs one. `pnpm nx run resilience-core-tripwire:typecheck-spec` and `:test` (criterion .4).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-docs --only tripwire-docs.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-docs.1] TW34 README.md has an install section, three consumer recipes (a gate in a request pipeline with `assertOpen`/`trip`, a HITL gate in a CLI with `interactiveGate`, an unlock bin in five lines with `runUnlockCli`), the stateDir / ADHD_HOME explanation, the two clear policies (`confirm-token`, `open`), the redaction rules and the local-disk (not NFS) caveat.
- [tripwire-docs.2] TW34 docs/ERRORS.md lists every error code of src/lib/errors.ts with its class, its cause and its remediation, and docs/RECOVERY.md is the operator runbook: it names the break-glass `rm` of the lock file with the exact path layout (`<stateDir>/tripwire/<key>.lock`), how to read the audit log, the unlock bin and the `.blocked` and `.cleared` sidecars.
- [tripwire-docs.3] TW34 CHANGELOG.md has a `0.1.0` entry listing the package's features, every exported function, class and constant under src/lib has a JSDoc block (the preceding non-empty line closes a `/** */` comment), and no document carries an AI attribution line (Generated with, Co-Authored-By, written by an AI).
- [tripwire-docs.4] README examples compile and run: src/test/unit/readme-examples.spec.ts cites ticket 8468f7b1 and its id, contains one test per fenced `ts` block of README.md (each README example is copied into the spec and exercised against the memory fs), and `nx run resilience-core-tripwire:typecheck-spec` and `:test` exit 0.
- [tripwire-docs.5] Only owned paths changed by [psm:tripwire-docs] commits (README.md, CHANGELOG.md, docs/ and the readme-examples spec of the tripwire package); no other source file is modified.

---

## Reservations

```text
read_only:  ["packages/resilience/resilience-core-tripwire/src/lib/", "packages/resilience/resilience-core-tripwire/package.json"]
mutates:    ["packages/resilience/resilience-core-tripwire/README.md", "packages/resilience/resilience-core-tripwire/CHANGELOG.md", "packages/resilience/resilience-core-tripwire/docs/", "packages/resilience/resilience-core-tripwire/src/test/unit/readme-examples.spec.ts"]
```

---

## Contract Promise

Added: README, CHANGELOG, docs/ERRORS.md, docs/RECOVERY.md and the README spec of the tripwire package. JSDoc is comment-only: no behavior changes.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-docs]`:

- [ ] After README, ERRORS and RECOVERY — commit: `docs(resilience-core-tripwire): README, errors and recovery runbook [psm:tripwire-docs]`
- [ ] After the changelog, JSDoc and the examples spec — commit: `docs(resilience-core-tripwire): changelog, JSDoc, compiled examples [psm:tripwire-docs]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- The guard checks that every exported function, class and constant under `src/lib` is preceded by a `/** */` block: add JSDoc, never change a signature.
- Write the README as final truth (no historical commentary, no 'now'/'previously').
