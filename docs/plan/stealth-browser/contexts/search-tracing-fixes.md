# search-tracing-fixes — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** search-mcp-iserror, fix-search-build, fix-search-output, fix-search-fetch, fix-search-engine, fix-core-parsers, fix-core-lifecycle, fix-core-errors, fix-tripwire · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-tracing-fixes`
**Executor:** executor=typescript-pro tier=sonnet/high · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Both hosts produce the spans the user expects for every dispatched call: UNKNOWN_PROVIDER is reachable from the CLI and the MCP host and the span records the code, a rejected flag still produces a span, and no span carries the bogus op id `op`.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/search-tracing-fixes.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- Why the validation failed (tracing-log-validation): (a) the provider input is an enum, so schema validation rejects an unknown provider before the verb runs and UNKNOWN_PROVIDER is unreachable from MCP; the CLI flag check rejects it too. Drop the enum from the provider input and the CLI flag check so the verb throws UNKNOWN_PROVIDER and the span records that code on both hosts. (b) Telemetry init runs after flag validation, so a rejected flag leaves no span: move `initTelemetry` ahead of flag validation. (c) A duplicate `adhd.op.error` event carries the bogus op id `op`: remove the duplicate.

- `--help` is explicitly not a dispatch: it writes no span. Document that in docs/OBSERVABILITY.md.

- Add a unit spec per fix that drives the real host code in process (the CLI `run(argv)` entry and the in-process MCP client) with an injected telemetry sink and an injected process-spawn fake; assert the span names, the code `UNKNOWN_PROVIDER`, the rejected-flag span and the single error event.

- Restore nothing else: this state is the last editor of the search sources before tracing-log-validation re-runs, which treats any later code change as stale.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:search-tracing-fixes]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-tracing-fixes` runs every acceptance criterion below (red until the work is done); `--only search-tracing-fixes.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-tracing-fixes --only search-tracing-fixes.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [search-tracing-fixes.1] UNKNOWN_PROVIDER is reachable from both hosts: a spec cites [search-tracing-fixes.1] and drives the CLI and the in-process MCP host with an unknown provider, asserting the verb's UNKNOWN_PROVIDER error and the span's recorded code; titles carry `UNKNOWN_PROVIDER`, `cli`, `mcp`, `span`; the provider input has no enum and the CLI flag check no longer rejects it.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/tracing.ts", "entrypoint/stealth-search/src/telemetry.ts", "entrypoint/stealth-search/src/cli.ts", "entrypoint/stealth-search/src/host-flags.ts", "entrypoint/stealth-search/src/host-errors.ts", "entrypoint/stealth-search/src/host-projection.ts", "entrypoint/stealth-search/src/api.ts", "entrypoint/stealth-search/src/index.ts", "entrypoint/stealth-search/test/unit/hosts/", "entrypoint/stealth-search/test/unit/tracing/", "entrypoint/stealth-search/docs/OBSERVABILITY.md", "entrypoint/stealth-search/docs/CONFIGURATION.md", "entrypoint/stealth-search/README.md", "docs/plan/stealth-browser/evidence/search-tracing-fixes.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/search-tracing-fixes.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-tracing-fixes]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; fixes the failed tracing-log-validation
