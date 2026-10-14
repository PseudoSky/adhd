# ADR draft — MCP adapter: raw-text string results, tool-execution errors as `isError`, tool metadata pass-through

**Status:** Proposed (draft for owner approval; not filed under `docs/decisions/`).
**Owner:** pseudosky.
**Extends:** ADR-0004 (flat MCP content payload). D1–D6 of ADR-0004 stay in force except where Decision 1 below narrows D1 for string returns.
**Drives:** REMEDIATION-PLAN segments R4 (apigen-plugin-mcp adapter), R9 (policy serve through `mcpPlugin.run`), owner decisions BA-2, BA-3, BA-4.
**Grounding:** `packages/apigen/apigen-plugin-mcp/src/lib/run.ts`, `packages/apigen/apigen-base-errors/src/lib/errors.ts`, `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts`, MCP specification 2025-06-18 "Tools" (§Error Handling, §Structured Content).

## TL;DR for the next agent

- `writeResult` emits a string return as the raw string in `content[0].text`; every non-string return keeps ADR-0004 (`JSON.stringify`, `structuredContent` only for an object return).
- `writeError` stops re-throwing for tool-execution failures: `permission_denied`, `unauthenticated`, `not_found`, `invalid_argument` and gateway-unavailable become a `CallToolResult` with `isError: true`. Unknown tool names, non-`ApiError` throws and plain `internal` stay JSON-RPC protocol errors.
- The text of an `isError` result is `<code>: <message>`; the machine-readable code travels in the result `_meta` under the key `adhd/error`.
- `tools/list` passes through `title` and `annotations` from operation metadata (E3), next to the existing `description` / `inputSchema` / `outputSchema`.
- The mapping table in Decision 2 is a **proposal**; the owner approves each row.

## Context

1. `writeResult` stringifies every result: `content: [{ type: 'text', text: JSON.stringify(result) }]` (`apigen-plugin-mcp/src/lib/run.ts:329-332`). A tool that returns the string `ok` reaches the host as `"ok"` with quotes. For a wrapped CLI or an upstream MCP tool whose answer is prose, the host sees a JSON-encoded string.
2. `writeError` re-throws every error (`run.ts:335-345`), and the `CallToolRequestSchema` handler re-throws again after logging (`run.ts:707-731`). The SDK turns the throw into a JSON-RPC error. A policy refusal therefore arrives as a protocol error, not as a tool result the model can read and react to.
3. The MCP specification 2025-06-18 (Tools, §Error Handling) defines two channels: protocol errors (JSON-RPC) for "Unknown tools", "Invalid arguments", "Server errors"; tool execution errors (`isError: true` in the result) for "API failures", "Invalid input data", "Business logic errors". It also says (§Structured Content) a tool returning structured content SHOULD also return the serialized JSON in a TextContent block.
4. The canonical error codes are five: `invalid_argument`, `unauthenticated`, `permission_denied`, `not_found`, `internal` (`apigen-base-errors/src/lib/errors.ts:24-30`). `MCP_ERROR_KIND` maps every code to `'error'` (`errors.ts:66-69` onward); `run.ts:343` only touches it to keep the import wired.
5. "Unavailable" is not a code. The gateway raises `ApiError('internal', "host '<h>' unavailable: <reason>", detail)` with `detail.gatewayCode === 'unavailable'` (`apigen-engine-gateway/src/lib/gateway.ts:87-103`). Between supervised restarts (BA-6) this is what a host sees.
6. The tool list carries only `description`, `inputSchema`, `outputSchema` (`ToolListMeta`, `run.ts:146-150`; `listTools`, `run.ts:263-281`). Upstream `title` and `annotations` are dropped. The policy serve tests pin them today through the passthrough server (`entrypoint/policy/src/test/functional/s7-serve.spec.ts:72`: `toMatchObject({ name: 'notes_add', title: 'Add', description: 'Add a note', annotations: { readOnlyHint: false } })`).
7. Unknown tool names throw `new Error('Unknown tool: …')` before any dispatch (`run.ts:689`); `s7-serve.spec.ts:124` pins `rejects.toThrow(/Unknown tool/)`.
8. INTERFACES D-04 (refusal = `permission_denied`, CLI exit 3) and D-08 (a serve refusal reaches the host as `isError: true` carrying the reason) are the contracts this ADR keeps. Today D-08 holds only because `serveMcpPassthrough` builds its own SDK server; owner decision O-8 removes that server from the serve path, so `mcpPlugin.run` must carry D-08 itself.

## Decision

1. **String results are raw text (BA-2).** In `writeResult`, when the dispatched result is a JavaScript `string`, emit `content: [{ type: 'text', text: result }]` and no `structuredContent`. Every other value keeps ADR-0004 D1–D3 unchanged. Streams keep `projectStreamMcp` (`run.ts:314-317`). This is a general apigen-plugin-mcp change for every service, not a policy special case.

2. **Error channel mapping (BA-4).** `writeError` writes `raw.output` for the rows marked *result* and re-throws for the rows marked *protocol*. The `CallToolRequestSchema` handler returns `raw.output` when `writeError` set it, and re-throws otherwise. **Each row requires owner approval.**

   | Error | Channel | `content[0].text` | `_meta["adhd/error"]` | Basis |
   | --- | --- | --- | --- | --- |
   | `ApiError('permission_denied')` | result, `isError: true` | `permission_denied: <message>` | `{ code: 'permission_denied' }` | BA-4 (owner-decided); spec "business logic errors"; INTERFACES D-04/D-08 |
   | `ApiError('unauthenticated')` | result, `isError: true` | `unauthenticated: <message>` | `{ code: 'unauthenticated' }` | **Proposed.** Same audience as a refusal: the model should stop and report. |
   | `ApiError('not_found')` | result, `isError: true` | `not_found: <message>` | `{ code: 'not_found' }` | **Proposed.** Spec "business logic errors". |
   | `ApiError('invalid_argument')` | result, `isError: true` | `invalid_argument: <message>` | `{ code: 'invalid_argument' }` | **Proposed, explicit owner choice.** The spec lists "Invalid arguments" as protocol and "Invalid input data" as tool execution. The validate-Layer rejects a call whose arguments the model wrote; an `isError` result lets the model read the message and retry. Alternative: keep it a protocol error (`-32602`). |
   | `ApiError('internal')` with `detail.gatewayCode === 'unavailable'` | result, `isError: true` | `unavailable: <message>` | `{ code: 'internal', gatewayCode: 'unavailable' }` | **Proposed.** Spec "API failures". Keyed on `detail`, because no `unavailable` code exists (`errors.ts:24-30`) and none is added. |
   | `ApiError('internal')` (any other detail) | protocol (re-throw) | — | — | **Proposed.** Spec "server errors"; keeps internal fault text out of the model's context. |
   | Non-`ApiError` throw | protocol (re-throw) | — | — | **Proposed.** Same as `internal`. |
   | Unknown tool name | protocol (unchanged, `run.ts:689`) | — | — | Spec "unknown tools"; pinned by `s7-serve.spec.ts:124`. |
   | Error inside a stream after the first chunk | unchanged (`projectStreamMcp`) | — | — | Out of scope. |

   The `_meta` key name `adhd/error` is proposed; the MCP result `_meta` object is the carrier because it is outside the model-facing `content`.

3. **Tool metadata pass-through (BA-3, E3).** `ToolListMeta` gains optional `title?: string` and `annotations?: Record<string, unknown>`. The values come from operation metadata (the E3 slot on `Operation` / `MountedOperation`, specified in the SPEC §7.1 edit draft). `listTools` includes each only when present. Extracted TS operations carry neither, so their list entries are unchanged.

4. **Cancellation.** The handler passes the SDK request `extra.signal` into the runtime call as `signal` (today the handler takes only `req`, `run.ts:685`). This is recorded here because the same handler changes; the signal contract itself is in the SPEC §7.1 edit draft.

5. **Envelope `_meta`.** Out of scope for this ADR. `run.ts:692` reads `_meta` from inside `arguments` (TAXONOMY F6); the plan records it as an open finding and does not change it.

## Consequences

- An unmodified MCP host sees a policy refusal as a tool result it can show to the model, with the reason in text, for every apigen-hosted service.
- Consumers that `JSON.parse(content[0].text)` on a tool whose return type is `string` now get raw text and must stop parsing. In-repo readers of `content[0].text` found by search: `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:499`, `packages/apigen/apigen-plugin-mcp/src/test/flat-content-payload.spec.ts`, `packages/apigen/apigen-plugin-mcp/src/test/stream.spec.ts`, `packages/agent/agent-plugin-budget/src/__tests__/budget-plugin.test.ts`, `entrypoint/agent-mcp/src/__tests__/traced-transport.test.ts`, and several `*.e2e.*` suites under `entrypoint/backlog` and `entrypoint/agent-mcp`. Whether each of them reads a string-returning apigen tool is UNVERIFIED; the plan lists this as an owner item because `entrypoint/backlog` and `entrypoint/agent-mcp` are not approved for edits.
- A caller that relied on a thrown JSON-RPC error for `not_found` / `permission_denied` now receives a result with `isError: true`. The MCP SDK client `callTool` resolves instead of rejecting for those rows.
- ADR-0004 D6 republish order applies: apigen-engine-runtime and apigen-plugin-mcp publish before any consumer.

## Alternatives

- Keep re-throwing and convert only in the policy entrypoint. Rejected by BA-4 (general fix in apigen-plugin-mcp).
- Add an `unavailable` code to `ERROR_CODES`. Rejected: apigen-base-errors is not an approved package, and `detail.gatewayCode` already carries the distinction.
- Put the error code in `structuredContent`. Rejected: ADR-0004 D2 ties `structuredContent` to an object `outputSchema`, which an error result does not satisfy.

## What does NOT change

ADR-0004 D1–D6 for non-string results; the HTTP and CLI error marshals; `CLI_EXIT_CODE`; the streaming projection; the unknown-tool protocol error.

## Evidence

- `packages/apigen/apigen-plugin-mcp/src/lib/run.ts:146-150, 263-281, 306-333, 335-345, 685-731`.
- `packages/apigen/apigen-base-errors/src/lib/errors.ts:24-30, 58-69`.
- `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts:87-103`.
- `entrypoint/policy/src/test/functional/s7-serve.spec.ts:72, 124`.
- MCP specification 2025-06-18, Tools: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools> (§Error Handling, §Structured Content), fetched 2026-10-14.
