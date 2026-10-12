# tracing-namespace-proof — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** tracing-plugin, tests-e2e · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tracing-namespace-proof`
**Executor:** `test-automator` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

A binary spec proves the tracing namespace is correct: the configured plugin, driven against a real sox-telemetry file sink for a real stealth-browser verb, emits only `adhd.<op>.*` records, and the package's own singleton would emit `apigen.*` (negative control). A mutation proves the spec has teeth.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/unit/tracing/tracing-namespace.spec.ts`.

- **Reference Pattern:** `entrypoint/backlog/src/server.tracing-six-tags.spec.ts` (real-sink pattern); `@adhd/sox-telemetry` `initTelemetry`; `packages/apigen/apigen-plugin-tracing/README.md`.

- **Delta Spec:** The spec initializes telemetry to a temp file sink, mounts the CONFIGURED `tracingPlugin` from `src/tracing.ts` on an apigen engine over a stubbed `chromeStatus` operation, calls it, reads the sink, and asserts every record `event` starts with `adhd.` and none starts with `apigen.`. A section labelled `NEGATIVE-CONTROL` mounts the package-level singleton and asserts it emits `apigen.` (so the assertion can fail). Header cites ticket 8468f7b1 and `[tracing-plugin.N]`.

- **Invariants:** [inv:trace-namespace] [inv:tests-cite]; the guard's mutation flips `serviceName` to 'apigen', requires the spec to FAIL, and restores `src/tracing.ts` byte-for-byte in a finally block. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tracing-namespace-proof]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tracing-namespace-proof` — runs every acceptance criterion below (red until the work is done); `--only tracing-namespace-proof.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tracing-namespace-proof --only tracing-namespace-proof.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

_No criteria yet._

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/tracing.ts", "entrypoint/stealth-browser/src/server.ts"]
mutates:    ["entrypoint/stealth-browser/src/test/unit/tracing/"]
```

---

## Contract Promise

Added: one spec file. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tracing-namespace-proof]`:

- [ ] After the spec passes against the real tracing.ts -- commit: `test(stealth-browser): tracing namespace proof [psm:tracing-namespace-proof]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Runs AFTER tests-e2e on purpose: the guard temporarily rewrites `src/tracing.ts`, which a concurrent build/e2e would bake into dist.
- If a mutation run is interrupted, `git restore entrypoint/stealth-browser/src/tracing.ts` (you own that file only for this purpose); never leave it flipped.
