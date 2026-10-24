# port-fixes — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** failsafe-inventory, mig-capture-parsers, mig-chrome-manager, mig-queries · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py port-fixes`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The ported library is correct before anything is tested, reviewed or consumed: the five defects the port inherited are fixed with regression tests, the strict typings are repaired instead of weakened, dead code is deleted, the greenfield names are applied at the source (`PageSource`, no `getSearchSessionId`, no `@deprecated`), the scratch lifecycle test is ported as a unit spec, and the whole unit lane is green. Every unit-test completion state depends on this one, so no spec ever pins a defect.

---

## Semantic Distillation

- **Primitive:** MODIFY `entrypoint/stealth-browser/src/lib/**` (typing repairs, the BigInt/number conversion, the session-cookie expiry mapping, the cdpCall open-wait, dead-code deletion, the renames), `vite.config.ts`, `tsconfig.spec.json`; CREATE `src/test/unit/chrome-manager/chrome-lifecycle.spec.ts` (port of the scratch `chrome-lifecycle-test.ts`) and the regression specs under `src/test/unit/domains-storage/`. Also MODIFY `entrypoint/stealth-browser/package.json` (dependencies only) and `pnpm-lock.yaml`.

- **Reference Pattern:** `/Users/nix/dev/ai/scratch/agent-browser/chrome-lifecycle-test.ts` (the five lifecycle scenarios), `evidence/` and the unit specs the earlier test states left in progress (the `it.fails` pin for the BigInt defect in `domains-storage/history.spec.ts`), ADR-0002 (correct the source, never alias around it).

- **Delta Spec:** Fix at the source, never around it. (1) `typecheck` and `typecheck-spec` exit 0 on the lib, the specs and `vite.config.ts` with `strict` and `noPropertyAccessFromIndexSignature` kept. (2) `storage/helpers.ts` keeps the immutable read-only opener `readBigInts`; `hydrateVisit` and `getRedirectChain` convert BigInt columns to plain numbers; the `it.fails` pin becomes a passing test. (3) `CookieClient.getCookies` maps `expires_utc = 0` (session cookie) to a null expiry. (4) `domains/transport.ts` `cdpCall` waits for the socket to open before sending. (5) Unused symbols the lint flagged are deleted. (6) Greenfield names at source: `types.ts` exports `PageSource` (was `SearchResultSource`), `session.ts` drops `getSearchSessionId`, `capture/dom.ts` loses its `@deprecated` tag and its header says it is a SERP-oriented walker, and `cdp/index.ts` exports `IdleShutdown`, `CdpClient`, `browserSession` and `getSessionId` so the `cdp` namespace needs no deep import. (7) The scratch lifecycle test becomes `chrome-lifecycle.spec.ts` with a temp heartbeat path and a dead CDP port. (8) `port-manifest.json` records the renames (`allowed_renames`) and drop (`allowed_drops`) and the `_rearmIdle` must-contain token so port parity stays honest. (9) Dependency for the capture sink (port-fixes.12; no approval gate, an owned package): add `@adhd/sox-store-adapter` at `^0.13.3` (the range `entrypoint/backlog/package.json` and the root override already use) to `dependencies`, run the workspace install so `pnpm-lock.yaml` resolves it, and make `vite.config.ts` use `externalizeRealDeps(__dirname)` (imported from `../../tools/vite-plugins/externalize.mjs`, exactly as `entrypoint/backlog/vite.config.ts` does) next to the `/^node:/` external so rollup keeps owned packages out of `dist/index.js`. The store adapter is ESM-only: it is only ever reached through a lazy `import()` in `capture-upgrade`. The `@adhd/sox-service-proxy` dependency is NOT added here: it is declared once, at its final `~0.6.0` range, by `sp-link`. `surface-hosts` still owns the later `module` field removal (ADR-0003).

- **Invariants:** [inv:greenfield] (the package is brand new and public: no legacy alias, no compatibility export) [inv:esm-js-specifiers] [inv:stealth] [inv:unit-purity] [inv:tests-cite] [inv:live-chrome]. [inv:no-features-removed]: delete legacy code and legacy tests freely when every feature they touched has its inventory row pinned elsewhere; the capture/dom.ts walker stays (a feature, flagged for the user); behavior fixes only where the source is demonstrably buggy (BigInt, expires_utc 0, ws.send before open), each pinned by a new test; the inventory rows you own are pinned (port-fixes.8, .11). Line-similarity and export-name parity are not required. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:port-fixes]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py port-fixes` — runs every acceptance criterion below (red until the work is done); `--only port-fixes.N` runs one. `nx run stealth-browser:test` is the slow gate (.9): run `lint`, `typecheck` and `typecheck-spec` first.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py port-fixes --only port-fixes.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [port-fixes.1] Strict typing, never weakened: `nx run stealth-browser:typecheck` and `:typecheck-spec` exit 0 on the ported lib, specs and vite.config.ts (typings are fixed; tsconfig keeps `strict` and `noPropertyAccessFromIndexSignature`, and no `@ts-nocheck`, `@ts-ignore` or `@ts-expect-error` exists in src/lib or vite.config.ts).
- [port-fixes.2] Defect 1 (BigInt): storage/helpers.ts still opens with `readBigInts` (the immutable read-only opener is kept), hydrateVisit and getRedirectChain return plain numbers (converted, not dropped), and the former `it.fails` pin in domains-storage/history.spec.ts is a real passing test: no `it.fails` remains under src/test and a spec asserts the redirect-chain ids are `number`.
- [port-fixes.3] Defect 2 (cookie expiry): a unit test in domains-storage/cookies.spec.ts proves CookieClient.getCookies maps `expires_utc = 0` (a session cookie) to a null expiry instead of 1601-01-01.
- [port-fixes.4] Defect 3 (cdpCall before open): domains/transport.ts waits for the socket to open before `send`, and a unit test in domains-storage/transport.spec.ts drives a WebSocket stub that opens asynchronously and proves cdpCall resolves with the reply (not null) and never sends before open.
- [port-fixes.5] The scratch chrome-lifecycle-test.ts is ported as a unit/lifecycle spec: src/test/unit/chrome-manager/chrome-lifecycle.spec.ts covers all five scenarios (deferral does not stamp the deferrer's heartbeat, genuine activity stamps, stale sibling lets shutdown proceed, absent sibling proceeds, dead sibling PID is ignored), uses a temp heartbeat path and a dead CDP port (never the live /tmp/stealth-browser-heartbeat), cites ticket 8468f7b1 and a valid port-fixes.N id; chrome-lifecycle later replaces the heartbeat mechanism with connection-based presence through the reaper link and keeps the same behaviors (it then cites chrome-lifecycle.N and the heartbeat tokens are no longer required).
- [port-fixes.6] Dead code the lint flagged is gone without behaviour change: `nx run stealth-browser:lint` exits 0 with no `no-unused-vars` warning (an unused symbol is deleted or genuinely used, never silenced with eslint-disable), and the full unit lane still passes (see .9).
- [port-fixes.7] Greenfield names at source: lib/types.ts exports PageSource (renamed from SearchResultSource), lib/session.ts has no getSearchSessionId alias, capture/dom.ts carries no `@deprecated` tag and its header honestly states it is a SERP-oriented walker, and lib/cdp/index.ts exposes IdleShutdown, CdpClient, browserSession and getSessionId so the `cdp` namespace needs no deep import.
- [port-fixes.8] Feature parity after the fixes: failsafe-inventory.json exists and every row owned by port-fixes is pinned by a feature-level unit test citing its row id; the capture/dom.ts Google-SERP walker is still present unless the user decided otherwise (it is flagged, not decided, in the return); line-similarity and export-name parity are NOT required (greenfield).
- [port-fixes.9] The whole unit lane is green on the corrected lib: `nx run stealth-browser:test` exits 0 (this is what unblocks tests-unit-core, tests-unit-data and tests-unit-extract).
- [port-fixes.10] Only owned paths changed by [psm:port-fixes] commits.
- [port-fixes.11] [inv:no-features-removed] port-fixes removes no feature: deleted dead code and legacy tests are free only when the feature they touched has its inventory row pinned elsewhere (every row owned by port-fixes is pinned), behavior fixes are limited to demonstrable source bugs (BigInt, expires_utc 0, ws.send before open) each pinned by a new test, and the inventory file is unchanged since failsafe-inventory (row_count not reduced).
- [port-fixes.12] Dependencies for the capture sink (no approval gate, an owned package): package.json `dependencies` lists @adhd/sox-store-adapter at ^0.13.3, vite.config.ts builds with `externalizeRealDeps(__dirname)` (imported from tools/vite-plugins/externalize.mjs) so no workspace package is inlined into dist, pnpm-lock.yaml resolves the store adapter, and `nx run stealth-browser:build` exits 0 with dist/index.js containing no inlined copy of createStoreAdapter (a `require` or dynamic `import()` of the name only). The @adhd/sox-service-proxy dependency is declared exactly once, by sp-link.

---

## Reservations

```text
read_only:  ["/Users/nix/dev/ai/scratch/agent-browser/", "docs/plan/stealth-browser/scripts/port-manifest.json"]
mutates:    ["entrypoint/stealth-browser/src/lib/", "entrypoint/stealth-browser/vite.config.ts", "entrypoint/stealth-browser/tsconfig.spec.json", "entrypoint/stealth-browser/src/types/", "entrypoint/stealth-browser/src/test/unit/chrome-manager/chrome-lifecycle.spec.ts", "entrypoint/stealth-browser/src/test/unit/domains-storage/", "entrypoint/stealth-browser/package.json", "pnpm-lock.yaml"]
```

---

## Contract Promise

Modified: `entrypoint/stealth-browser/src/lib/**`, `vite.config.ts`, `tsconfig.spec.json`, the regression specs. Added: `src/test/unit/chrome-manager/chrome-lifecycle.spec.ts`. Deleted: dead code only. No behaviour change except the three documented defect fixes.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:port-fixes]`:

- [ ] After the typing and lint repairs — commit: `fix(stealth-browser): repair strict typings and delete dead code [psm:port-fixes]`
- [ ] After the BigInt, cookie-expiry and cdpCall fixes with their regression tests — commit: `fix(stealth-browser): port defects with regression tests [psm:port-fixes]`
- [ ] After the greenfield renames and the lifecycle spec — commit: `refactor(stealth-browser): greenfield names at source, lifecycle spec [psm:port-fixes]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- The three fixed defects are product bugs the port inherited; the specs that pinned them (`it.fails`) were written by earlier test states and are converted here, which is why this state owns `src/test/unit/domains-storage/`.
- Never silence a lint or type error: `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` and `eslint-disable no-unused-vars` all fail the guard.
- `capture-upgrade` and `chrome-lifecycle` follow this state and may rewrite `capture/**` and `chrome-manager.ts`; keep the port faithful here.
