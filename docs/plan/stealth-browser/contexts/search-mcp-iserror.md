# search-mcp-iserror — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** conform-search · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-mcp-iserror`
**Executor:** executor=typescript-pro tier=sonnet/high · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The MCP host follows adhd ADR-0018: validation failures are tool results with isError, the isError channel bug 4909102e is closed, the comments say what is true, the host uses buildApigenPackage, and no empty e2e target is left to fail CI.

---

## Semantic Distillation

- **Primitive:** act only on the owned paths listed under Reservations; the evidence record is `docs/plan/stealth-browser/evidence/search-mcp-iserror.md`.

- **Reference Pattern:** `docs/plan/stealth-browser/contexts/_shared.md` ([inv:test-layout] pins the layout moves), `docs/standards/testing.md` and `AGENTS.md` on main (`git show main:<path>`), and the main impact report of the 2026-10-23 amendment (README `Amendment 2026-10-23`).

- **Delta Spec:**

- ADR-0018 (read docs/decisions/0018-mcp-adapter-string-results-iserror-metadata.md on main): every ApiError now returns a tool result with `isError: true` and `_meta['adhd/error']`; only non-ApiError throws still reject. Update the three failing assertions (`test/unit/hosts/mcp-inprocess.spec.ts` extraArgs/chromePath, `required key 'input'`, and `test/unit/use-cases/hosts.spec.ts` validation) to `res.isError === true` plus the `invalid_argument: ...` text; keep `rejects` for UNKNOWN_PROVIDER (a StealthSearchError, not an ApiError).

- Close backlog 4909102e (missing isError channel): a StealthSearchError raised by a verb must reach the MCP client as an isError tool result carrying its code, not a JSON-RPC rejection, if the apigen adapter can be satisfied by making StealthSearchError an ApiError; otherwise record in evidence why UNKNOWN_PROVIDER stays a rejection and test exactly that. Reword the contradicting comments (`src/errors.ts:16`, the 'no isError channel' comment in mcp-inprocess.spec.ts).

- Replace `dereferenceSchema` and the manual package assembly in `src/server.ts` (~:150-192, :292-321) with `buildApigenPackage` from `@adhd/apigen-engine-runtime`; keep the `requireExplicitInput` allowlist behaviour proved by the existing specs. `nx typecheck stealth-search` proves the LayerCapability union.

- Remove the zero-file `e2e` target from project.json and `vitest.e2e.config.ts` (there is no e2e file; `defineE2eConfig` has no passWithNoTests), unless `check-lane-reachability.mjs` on the merged tree demands a lane, in which case add a genuine `test/e2e/*.e2e.ts` with a tier P/H/X header and `gap:`.

- The fix is proven by a unit spec that simulates the real use case of the report, not by a mock of the fixed function; every failure the fix can raise is a typed error ([inv:typed-errors]); no e2e, no subprocess, no network, no real Chrome ([inv:unit-purity], [inv:live-chrome]).

- **Invariants:** [inv:shared-worktree] [inv:owned-paths-only] [inv:no-main-writes] [inv:no-ai-attribution] [inv:tests-cite] [inv:test-layout] [inv:typed-errors] [inv:unit-purity] [inv:live-chrome] [inv:pnpm-only]. Commit only your own explicit paths, tag every commit `[psm:search-mcp-iserror]`, never `git add -A`, never stash or hard-reset, commit with `--no-verify` as the previous states did.

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-mcp-iserror` runs every acceptance criterion below (red until the work is done); `--only search-mcp-iserror.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-mcp-iserror --only search-mcp-iserror.N`, loaded from `scripts/guards/amend_a.py`, text in `scripts/guards/amend-spec.json`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [search-mcp-iserror.1] The three assertions follow ADR-0018: mcp-inprocess.spec.ts and use-cases/hosts.spec.ts assert `isError` true with the `invalid_argument` text for extra-args/chromePath/required-key validation failures (the specs cite [search-mcp-iserror.1]; titles carry `isError`, `invalid_argument`, `ADR-0018`), and UNKNOWN_PROVIDER still rejects; the host specs are green.

- [search-mcp-iserror.2] (backlog 4909102e) The isError channel is closed and the comments tell the truth: a spec cites [search-mcp-iserror.2] proving how a typed StealthSearchError reaches an MCP client (titles carry `4909102e`, `isError`, `code`), and `src/errors.ts` no longer claims an isError form that does not exist.
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/server.ts", "entrypoint/stealth-search/src/errors.ts", "entrypoint/stealth-search/docs/ERRORS.md", "entrypoint/stealth-search/test/unit/hosts/", "entrypoint/stealth-search/test/unit/use-cases/hosts.spec.ts", "entrypoint/stealth-search/test/unit/errors/", "entrypoint/stealth-search/project.json", "entrypoint/stealth-search/vitest.e2e.config.ts", "docs/plan/stealth-browser/evidence/search-mcp-iserror.md"]
```

---

## Contract Promise

Modified or added: the owned paths above and `evidence/search-mcp-iserror.md`. Nothing else.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-mcp-iserror]`:

- [ ] After the work is green and the evidence is written — commit the work by explicit path.
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

executor=typescript-pro tier=sonnet/high; adhd ADR-0018; backlog 4909102e
