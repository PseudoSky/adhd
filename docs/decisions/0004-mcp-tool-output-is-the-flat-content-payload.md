# ADR-0004 — MCP tool output is the flat payload on `content`; no `{result}` envelope

**Status:** ACCEPTED (2026-09-25).
**Owner:** pseudosky.
**Supersedes:** nothing. (It reverses the *transport half* of the bug-fix `BUG-APIGEN-019`, which was a commit, never an ADR.)
**Drives:** `7d02c71c` (agent_search wraps results in a `{result}` envelope / apigen-garbage), `b6a04e7f` (walker emits `{}` for imported optional object properties), and the `structuredContent` half of the `-32602` schema class (`6fd8eed5`, `3a3e5884`).
**Grounding:** `architect-decision` verdict 2026-09-25 (APPROVE option A; risk LOW overall, MATERIAL for `structuredContent` readers only); owner approval 2026-09-25 ("full authority to publish and push"); a reproduction driven by a **real MCP stdio client** against both the exact host command and the unmodified built backlog server (5 of 8 search tools wrapped; all 18 backlog domain tools wrapped).

## TL;DR for the next agent

**apigen MCP tools emit the flat payload on the `content` text channel.** `outputSchema` (and therefore `structuredContent`) is emitted **only when the return is already a top-level `type:'object'`**. A non-object return — a union, array, or scalar — is passed through flat with **no envelope**. Never wrap a return under `result`.

**The trap to avoid:** the wrapper looks deliberate, and it is asserted by existing tests. It is neither an ADR nor a documented contract — it is the transport half of a bug fix whose *own source documentation* declares the flat shape. Re-introducing `{result:…}` re-creates the split-brain this ADR removes.

## Context

**The defect is a split channel, not merely an envelope.** For the *same* `tools/call`, `packages/apigen/apigen-plugin-mcp/src/lib/run.ts` emits:
- `content: [{type:'text', text: JSON.stringify(result)}]` — **flat** (~`:301-325`, `writeResult`)
- `structuredContent` — **wrapped** as `{result: value}`

So a host reading `content` sees the flat object while a host reading `structuredContent` sees `{result:{…}}`. Two shapes, one call, no declaration that either is canonical.

**Where the envelope comes from.** `packages/apigen/apigen-engine-runtime/src/lib/mcp-output-schema.ts` — `buildMcpOutputSchema` (`:37-58`) returns `{type:'object', properties:{result:<output>}, required:['result']}` + `wrapped:true` for **any** non-top-level-object output; `wrapMcpStructuredContent` (`:65-73`) produces `{result:value}`. Exercise sites: the advertised `tools/list` schema at boot, `writeResult` per call, and the generated stdio/HTTP host templates.

**Why it was written.** MCP restricts `Tool.outputSchema` to a root `type:'object'` (`@modelcontextprotocol/sdk` `dist/esm/spec.types.d.ts:1201-1208` — "Currently restricted to type: object at the root level"). `agent_search` returns a three-branch union, which cannot be passed through unwrapped as an `outputSchema`.

**Why that justification does not carry.** The constraint is on the **optional** `outputSchema`, not on the payload. Omitting `outputSchema` for a non-object return is protocol-legal and leaves `content` free to carry the true shape — which is exactly what the source already documents: the tool's own `response_structure`, and the external consumer's prompt (the researcher agent, which documents a flat `{provider, query, count, results, …}`). **The emitter contradicts its own declared contract.** That is the class `adhd ADR-0002` exists to close: correct the source rather than making every consumer unwrap.

**Measured blast radius.** 5 of 8 search tools were wrapped (`agent_search`, `agent_list_providers`, `agent_clear_tripwire`, `agent_shutdown_search_chrome`, `agent_provider_usage`); **all 18** in-repo backlog domain tools were wrapped (`backlog_query` content flat `{"ok":true,…}` vs structuredContent `{"result":{…}}`). Reproduced with a real JSON-RPC client against the exact host command and the unmodified built backlog server — never by importing the build and calling functions directly.

**Not established, stated plainly** (from the verdict's own caveat): the exact commit hash for `BUG-APIGEN-019` was not confirmed, and the SDK's `spec.types.d.ts` line range was not re-read (the `type:'object'`-root constraint is corroborated independently by code comments at `mcp-output-schema.ts:11-16` and the `BUG-APIGEN-MCP-ROOT-ONEOF-001` block in `run.ts`). Neither affects this decision.

## Decision

### D1 — The canonical shape is the flat payload on `content`

`content` text carries the tool's real return value, unwrapped. It is the single canonical channel.

### D2 — `outputSchema`/`structuredContent` only for an already-object return

`buildMcpOutputSchema` emits an `outputSchema` (and therefore a `structuredContent`) **only** when the return is already a top-level `type:'object'`. For a non-object return it returns `{outputSchema: undefined, wrapped: false}`.

`outputSchema` is optional in MCP, so this is protocol-legal. Where it **is** emitted for an object return, the existing object-validation behaviour is unchanged.

### D3 — No envelope, ever

A non-object return is passed through flat. `{result: …}` is not emitted, and `wrapMcpStructuredContent` is no longer the transport's default path for unions/arrays/scalars.

**Consequence, accepted:** a union/array return loses structured *validation* it never validly had — today that validation actively **rejects legitimate values** with `-32602` (the `oneOf` + catch-all class: `6fd8eed5`, `3a3e5884`, `b6a04e7f`). Removing it converts a wrong rejection into a permissive pass.

### D4 — Consumers read `content`; `structuredContent` readers must add a fallback

Hosts reading `content` are unaffected (already flat). Hosts reading `structuredContent` will find it **absent** for non-object returns and must fall back to `content`.

**This is MATERIAL for that one class and it is the price of the decision.** Note such a host is *already* out of contract today — the envelope contradicts the documented flat shape — so this converts a silent divergence into an explicit absence.

### D5 — Tests must stop enshrining the envelope

The assertions asserting `structuredContent === {result:…}` flip to assert `structuredContent` is **absent** and `content` carries the flat payload. Those sites include `apigen-plugin-mcp/src/test/run.e2e.ts`, `apigen-plugin-mcp/src/test/generate.spec.ts`, `apigen-engine-runtime/src/test/mcp-output-schema.spec.ts`, and `entrypoint/backlog/src/query-output-codec.spec.ts`.

Because the `[plugin-mcp.7]` block is `describe.skip`, **nothing default-running guards this behaviour today** — so the change must add a **default-running** integration test that drives a real MCP stdio client (never by importing the build) and asserts, for a union-returning tool, that `content` is flat and `structuredContent` is absent.

### D6 — Republish order

Republish `@adhd/apigen-engine-runtime` / `@adhd/apigen-plugin-mcp` **first**. The external `agent-browser` consumer needs a bump **only if** it actually consumes `structuredContent`; a `content` reader needs no bump, since that channel is byte-for-byte unchanged.

## Consequences

- **The split-brain is removed at its single choke point** (`buildMcpOutputSchema` / `wrapMcpStructuredContent`), not patched in each consumer — `adhd ADR-0002`.
- **A documented contract and its implementation agree again.** The tool's own `response_structure` and the external consumer prompt were flat while the emitter wrapped.
- **The `-32602` rejection class stops being reachable through this path**, because the offending `oneOf`/catch-all schema is no longer advertised.
- **`adhd ADR-0003` is unaffected but adjacent:** these are ESM-era packages today; the CJS-only migration does not interact with this decision.
- **Cost, accepted:** one MATERIAL consumer class must add a `content` fallback, and four test sites plus a skipped block must be rewritten.

## Alternatives considered

- **(B) Keep the wrapper; also wrap `content`; document the envelope.** **REJECTED.** It redefines the source's *documented flat contract* to match the workaround — the inverse of `adhd ADR-0002` — and changes the most widely read channel (text `content`) plus every consumer, a strictly larger blast radius than removing a wrapper at one choke point.
- **Consumer-side `.result` unwrapping.** **REJECTED.** It clears the symptom while leaving the split-brain, and must be repeated in every consumer forever.
- **Keep the wrapper only for unions, flat for scalars.** **REJECTED.** Two rules where one suffices, and it preserves the disagreement between advertised schema and payload for exactly the tools that matter most.

## What does NOT change

- **`adhd ADR-0001`** (stores → sox-store adapter; no env feature toggles) — untouched.
- **`adhd ADR-0002`** (correct the source) — untouched, and it is the governing argument **for** this decision.
- **`adhd ADR-0003`** (CJS-only) — untouched.
- **Object-returning tools keep their `outputSchema` and structured validation.**
- **The `content` text channel for object returns** — unchanged.
- **`b6a04e7f`** (the walker emitting `{}` for imported optional object properties) — this ADR does not fix it; that is a separate extractor defect.

## References

- `architect-decision` verdict, 2026-09-25 — APPROVE option (A); risk LOW overall, MATERIAL for `structuredContent` readers only.
- Owner approval, 2026-09-25 — "full authority to publish and push and continue fixing items."
- `packages/apigen/apigen-engine-runtime/src/lib/mcp-output-schema.ts:37-58, 65-73`; `packages/apigen/apigen-plugin-mcp/src/lib/run.ts` (`writeResult`, `listTools`, generated host templates).
- `@modelcontextprotocol/sdk` `dist/esm/spec.types.d.ts:1201-1208` (outputSchema restricted to a root `type:'object'`).
- Backlog: `7d02c71c` (the triaged defect), `b6a04e7f`, `6fd8eed5`, `3a3e5884`; `BUG-APIGEN-019` (the bug-fix whose transport half this reverses).
