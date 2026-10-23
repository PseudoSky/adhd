# fix-search-output — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-search · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-output`
**Executor:** executor=typescript-pro tier=sonnet/medium · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The default `search` output is bounded by result count AND bytes, and the retry spec no longer mutates the shared provider registry.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-search-output.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- 30 or more long-snippet results can exceed 8192 bytes under a count-only bound. Add a byte bound (a documented default constant, overridable by an input, typed error on a non-positive value) applied after the count bound; whole results only (never cut a result mid-record), an `omitted`/`truncated` marker with the count dropped. Unit spec: 40 results with 600-byte snippets serialize within the byte bound; 5 short results are untouched.

- `test/unit/verbs/retry.spec.ts` mutates the shared `PROVIDERS.github.retry`. Inject the registry (a `providers` dependency on the search deps) or take a per-test deep copy so no spec mutates the module singleton; assert in a spec that two consecutive tests see the pristine registry.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-search-output]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-output` runs every acceptance criterion below (red until the work is done); `--only fix-search-output.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-search-output --only fix-search-output.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-search-output.1] A spec under test/unit/verbs cites [fix-search-output.1] and simulates 40 long-snippet results: titles carry `8192`, `bytes`, `count`, `whole results` and `truncated`; the default output stays within the byte bound, short outputs are untouched; the spec is green.

- [fix-search-output.2] retry.spec.ts no longer mutates the shared registry: no assignment to `PROVIDERS.github.retry` (or any `PROVIDERS.*`) remains in test/unit, and a spec cites [fix-search-output.2] proving the registry is pristine across tests (titles carry `registry`, `pristine`, `per-test`).
- [fix-search-output.3] evidence/fix-search-output.md records the red-first proof: a `RED:` line with the failing assertion of each new spec on the untouched source and a `GREEN:` line with the passing run after the fix.
- [fix-search-output.4] `nx run stealth-search:lint`, `:typecheck`, `:typecheck-spec`, `:test` exit 0 and evidence/fix-search-output.md records each as `EXIT <command>: 0`.
- [fix-search-output.5] Only owned paths changed by [psm:fix-search-output] commits (search.ts, api.ts, output.ts and the verbs specs).
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/search.ts", "entrypoint/stealth-search/src/api.ts", "entrypoint/stealth-search/src/lib/output.ts", "entrypoint/stealth-search/test/unit/verbs/", "entrypoint/stealth-search/test/helpers/verbs/", "docs/plan/stealth-browser/evidence/fix-search-output.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-search-output.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-search-output]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
