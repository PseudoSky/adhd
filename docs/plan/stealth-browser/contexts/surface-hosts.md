# surface-hosts — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The same six verbs are reachable from three surfaces: the library (`src/index.ts`), a CLI (`stealth-browser`) and a stdio MCP server (`stealth-browser-mcp`), both generated from `api.ts` by apigen and both built into `dist/bin/`.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts`, `entrypoint/stealth-browser/bin/cli.ts`, `entrypoint/stealth-browser/bin/mcp.ts`; MODIFY `entrypoint/stealth-browser/package.json`.

- **Reference Pattern:** `entrypoint/backlog/src/server.ts` and `src/cli.ts` (MCP/CLI host shape, [ref:apigen-host]); `entrypoint/dispatch-cli/bin/cli.ts` (bin fallback rationale); `/Users/nix/dev/ai/scratch/agent-browser/server.mjs` (the current MCP host).

- **Delta Spec:** `server.ts` builds the apigen MCP server over `api.ts` with `@adhd/apigen-plugin-mcp`; `cli.ts` the CLI host with the cli-output plugin; `bin/cli.ts` and `bin/mcp.ts` are the executable entry shims (shebang, import from `../src/...js`). package.json: `bin: { stealth-browser: ./dist/bin/cli.js, stealth-browser-mcp: ./dist/bin/mcp.js }` and dependencies on the apigen packages (`@adhd/apigen-core-client`, `@adhd/apigen-engine-runtime`, `@adhd/apigen-plugin-mcp`, cli-output plugin) as used by `entrypoint/backlog`. The `usePlugins` arrays are authored here WITHOUT tracing; tracing-plugin adds it next.

- **Invariants:** [inv:esm-js-specifiers]; stdout of the MCP bin carries only JSON-RPC (logs go to stderr); stealth flags unchanged. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:surface-hosts]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts` — runs every acceptance criterion below (red until the work is done); `--only surface-hosts.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts --only surface-hosts.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [surface-hosts.1] src/server.ts (MCP stdio host via @adhd/apigen-plugin-mcp), src/cli.ts and bin/cli.ts, bin/mcp.ts exist.

- [surface-hosts.2] package.json declares bin entries stealth-browser and stealth-browser-mcp pointing into ./dist/bin/ and depends on the apigen core-client/engine-runtime/plugin-mcp/plugin-cli-output packages.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/index.ts", "entrypoint/backlog/src/", "entrypoint/dispatch-cli/bin/"]
mutates:    ["entrypoint/stealth-browser/src/server.ts", "entrypoint/stealth-browser/src/cli.ts", "entrypoint/stealth-browser/bin/", "entrypoint/stealth-browser/package.json"]
```

---

## Contract Promise

Added: server.ts, cli.ts, bin/cli.ts, bin/mcp.ts. Modified: package.json (bin + deps). Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:surface-hosts]`:

- [ ] After the CLI host works -- commit: `feat(stealth-browser): cli host [psm:surface-hosts]`
- [ ] After the MCP host works -- commit: `feat(stealth-browser): mcp host [psm:surface-hosts]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Known apigen failure class: optional booleans in return types break extraction (see surface-api). If `--help` crashes, fix the type, not the host.
- Use dependency ranges and package names exactly as `entrypoint/backlog/package.json` resolves them in this workspace; `nx run stealth-browser:lint` enforces dependency-checks.
- Do not launch a persistent Chrome in this state; `chromeStatus` against an unused port is the cheap probe.
