# prod-errors — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-errors`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])
**Parallel with:** prod-public-api (disjoint owned paths, proven by `check-disjoint.py`)

**Origin:** inserted by `productization-hold` from `PRODUCT-REVIEW.md`; criteria carry the review's PA ids in their text.

---

## Goal

First-run failures are structured errors with a stable `code` and a message that names the fix, not raw stack traces: Chrome missing, port busy, Node older than 22.5 (node:sqlite), Chrome not running. (Source: PRODUCT-REVIEW.md P5.)

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/errors.ts` and `entrypoint/stealth-browser/src/test/unit/errors/`.

- **Reference Pattern:** `entrypoint/stealth-browser/src/lib/chrome-manager.ts` and `src/lib/cdp/` (where the raw failures arise), `entrypoint/backlog/src/` (error handling in a sibling host).

- **Delta Spec:** `errors.ts` exports a `StealthBrowserError extends Error` with a readonly `code` (union `CHROME_NOT_FOUND | PORT_IN_USE | NODE_TOO_OLD | CHROME_NOT_RUNNING`) and a remediation message per code, plus `classifyError(err): StealthBrowserError | undefined` (maps the library's raw failures: ENOENT on the Chrome binary, EADDRINUSE, ECONNREFUSED on the debugging port) and `assertNodeVersion(process.versions.node)` (>= 22.5). No `process.env` reads. The library (`api.ts`, `src/lib/`) is NOT modified here: `surface-hosts` maps errors at the host layer (CLI exit code and stderr message, MCP `isError: true` with the code in the content) and runs the Node preflight in the bin shims. One unit test per code.

- **Invariants:** [inv:esm-js-specifiers] [inv:tests-cite] [inv:unit-purity]; no stack traces in user-facing messages; messages are one line each and name the fix. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:prod-errors]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-errors` — runs every acceptance criterion below (red until the work is done); `--only prod-errors.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py prod-errors --only prod-errors.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [prod-errors.1] (PA5.1) src/errors.ts defines an Error subclass with a stable `code` field covering CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD and CHROME_NOT_RUNNING, each with a remediation message naming the fix.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/lib/"]
mutates:    ["entrypoint/stealth-browser/src/errors.ts", "entrypoint/stealth-browser/src/test/unit/errors/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/errors.ts`, `entrypoint/stealth-browser/src/test/unit/errors/*.spec.ts`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:prod-errors]`:

- [ ] After errors.ts and its specs -- commit: `feat(stealth-browser): structured errors with remediation [psm:prod-errors]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Host-level behaviour (PA5.2 CLI exit and stderr, PA5.3 MCP isError, PA5.5 bin preflight) is guarded by `surface-hosts.12`, not here.
