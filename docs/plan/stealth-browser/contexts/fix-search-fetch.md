# fix-search-fetch — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** conform-search · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-fetch`
**Executor:** executor=typescript-pro tier=sonnet/medium · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

fetch refuses a public hostname that resolves to a private address, with a typed error, and the fetch specs lint clean.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/fix-search-fetch.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- `src/lib/fetch/policy.ts` decides SSRF by hostname only, so `docs.example.test` resolving to 10.0.0.5, 127.0.0.1, ::1, 169.254.169.254 or fd00::1 passes. Resolve the host (an injected resolver; the unit lane never touches the network) and check every returned address against the private, loopback, link-local and unique-local ranges; fail with FETCH_URL_REFUSED carrying the offending address in `detail`, before any request. A resolver failure is a typed error as well. Keep the default-allowed public path working.

- Lint: `test/unit/fetch/fetch-route.spec.ts:13` has a non-null assertion; replace it with a narrowing guard so `nx run stealth-search:lint` prints no warning for the file.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:fix-search-fetch]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py fix-search-fetch` runs every acceptance criterion below (red until the work is done); `--only fix-search-fetch.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py fix-search-fetch --only fix-search-fetch.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [fix-search-fetch.1] A spec under test/unit/fetch cites [fix-search-fetch.1] and simulates a public hostname resolving to private addresses: titles carry `resolves`, `169.254.169.254`, `10.0.0.5`, `::1`, `FETCH_URL_REFUSED` and `injected resolver`; the refusal happens before any request; the spec is green.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/fetch/", "entrypoint/stealth-search/test/unit/fetch/", "entrypoint/stealth-search/test/fixtures/fetch/", "entrypoint/stealth-search/test/helpers/fetch/", "docs/plan/stealth-browser/evidence/fix-search-fetch.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/fix-search-fetch.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:fix-search-fetch]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/medium
