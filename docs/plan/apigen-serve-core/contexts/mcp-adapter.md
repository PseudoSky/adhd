# mcp-adapter — mcp migration + first-time validate layer (BUG-001)

**Phase:** phase-2 · **Kind:** work · **Depends on:** audit-foundation · **Guard:** `CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test`

---

## Goal

`mcp` is a `TransportAdapter`; `createPackageInvoker`+`makeValidateLayer` are composed for the FIRST time (closing `BUG-APIGEN-SERVE-CORE-001` — malformed input now rejects with `invalid_argument`); `projectStreamMcp` is wired live; `toolMetas` are hoisted out of the per-request path; the tool-naming shim is collapsed; the mcp [def:parity-gate] is green via a real sdk client (incl. the malformed case) with a recorded [inv:negative-control].

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [mcp-adapter.1] mcp composes createPackageInvoker+makeValidateLayer for the first time (BUG-001 fix)

- [mcp-adapter.2] projectStreamMcp wired live (DEBT-002 mcp half)
- [mcp-adapter.3] tool-naming findOperation shim removed (collapsed into OpPlan.mcp.name)
- [mcp-adapter.4] committed mcp golden snapshot exists
- [mcp-adapter.5] mcp parity gate green via real @modelcontextprotocol/sdk client, incl. malformed->invalid_argument case
- [mcp-adapter.6] negative control: mcp regression turns parity RED, restore GREEN
- [mcp-adapter.7] mcp composes --use layer/mount via createPackageInvoker (dod.11)
- [mcp-adapter.8] toolMetas computed once at startup, hoisted out of the per-request streaming-http handler (dod.12)
- [mcp-adapter.9] both HTTP transports (sse + streaming-http) route handler errors through the adapter writeError guard — streaming-http no longer lacks the try/catch the sse path has (BUG-...-NO-ERROR-GUARD-001, dod.15)
- [mcp-adapter.10] real SSE-client + StreamableHTTP-client transport parity spec exists (handshake, session routing, graceful-error-no-teardown, abort) — dod.15
---

## Reservations

```text
read_only:  ["packages/apigen/apigen-engine-runtime/src/lib/op-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts", "packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts", "packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts", "packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts", "packages/apigen/apigen-engine-runtime/src/lib/validate-layer.ts", "packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts", "packages/apigen/apigen-engine-naming/src/lib/naming.ts", "packages/apigen/apigen-core-client/src/lib/plugin.ts"]
mutates:    ["packages/apigen/apigen-plugin-mcp/src/lib/run.ts", "packages/apigen/apigen-plugin-mcp/src/lib/generate.ts", "packages/apigen/apigen-plugin-mcp/src/lib/tool-naming.ts", "packages/apigen/apigen-plugin-mcp/src/lib/stream.ts", "packages/apigen/apigen-plugin-mcp/src/test/run.spec.ts", "packages/apigen/apigen-plugin-mcp/src/test/tool-naming.spec.ts", "packages/apigen/apigen-plugin-mcp/src/test/generate.spec.ts", "packages/apigen/apigen-plugin-mcp/src/test/transport-http-parity.spec.ts", "packages/apigen/apigen-plugin-mcp/src/test/golden/mcp.snapshot.json", "docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch"]
```

---

## Semantic Distillation

The HIGHEST-RISK Phase-2 state — MCP is GAINING validate-layer + streaming + `--use` for the first time, not collapsing onto an existing shape. Today `run.ts:126-173` calls `dispatch()` directly and imports no `createInvoker`/`makeValidateLayer` (`run.ts:1-22`); `run.ts:269-276` rebuilds the whole tool table PER REQUEST in `streaming-http` mode. Drive ONLY a real `@modelcontextprotocol/sdk` client against the BUILT server (AGENTS.md §"Proving an MCP server works") — never `run.ts` internals. Applies [fix:streaming-wired].

---

## Contract Promise

**modified:** `run.ts` (adapter + validate composition + hoisted `toolMetas`), `generate.ts`, `stream.ts` (`projectStreamMcp` called). **deleted:** `deriveToolName`/`findOperation` from `tool-naming.ts` (collapsed into `OpPlan.mcp.name`). **added:** `golden/mcp.snapshot.json` + `neg-control/mcp-adapter.patch`. **flagged behavior change:** malformed input `invalid_argument` (`[dod.4]`) — previously succeeded; call out as breaking in the commit/PR.

---

## Commit points

(1) capture + commit `golden/mcp.snapshot.json` first; (2) migration + parity green (incl. malformed→invalid_argument case); (3) neg-control recorded. Post-guard: `fix(apigen-plugin-mcp): compose validate-layer + migrate to TransportAdapter (BUG-APIGEN-SERVE-CORE-001)`.

---

## Notes for executor

Fixes BUG-APIGEN-SERVE-CORE-001 (first-time validate-layer) + wires projectStreamMcp. malformed->invalid_argument is a flagged behavior change. Real @modelcontextprotocol/sdk client only.


## Review folds

- **[fix:use-capability-explicit] (dod.11):** mcp gains `--use` layer AND mount composition via `createPackageInvoker` (GO §8.1) — state explicitly that mcp now hosts `--use` mount ops and pin it. dod.4 covers validate-layer composition; this is the SEPARATE mount capability.
- **[fix:mcp-toolmeta-hoist] (dod.12):** the tool table / `toolMetas` is computed ONCE at startup from `OpPlan`, NOT rebuilt per request in streaming-http mode (`run.ts:269-276`). Add a test asserting the build count stays 1 across multiple CallTool requests.
- Stamp `plan.transport = 'mcp'` per [fix:transport-stamping] — a hardcoded `'http'` in `dispatchForPlan` would mis-tag mcp mount provenance.
