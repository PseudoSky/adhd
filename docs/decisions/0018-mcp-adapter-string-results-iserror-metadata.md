# ADR-0018 — MCP adapter: raw-text string results, tool errors as `isError` results, tool metadata pass-through

**Status:** ACCEPTED (2026-10-14). Amends adhd ADR-0004 (additions only; no decision of adhd ADR-0004 is reversed).
**Owner:** pseudosky.
**Supersedes:** nothing. adhd ADR-0004 D1-D6 stay in force for every non-string result; the additions here are recorded as amendments in both files.
**Drives:** `docs/plan/policy-core/REMEDIATION-PLAN.md` segments R4 (apigen-plugin-mcp adapter) and R9 (policy serve through `mcpPlugin.run`); owner decisions BA-2, BA-3, BA-4, G-5, G-7.
**Grounding:** owner approvals 2026-10-14 (BA-4 / G-7: every `ApiError` code returns a tool result with `isError: true`; G-5: readers of `content[0].text` are in scope, audited first); `packages/apigen/apigen-plugin-mcp/src/lib/run.ts`, `packages/apigen/apigen-base-errors/src/lib/errors.ts`, `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts`; MCP specification 2025-06-18 "Tools" (Error Handling, Structured Content).

## TL;DR for the next agent

- A `string` return is emitted as the raw string in `content[0].text`, with no `structuredContent`. Every non-string return keeps adhd ADR-0004 (`JSON.stringify`; `structuredContent` only for an object return).
- Every `ApiError` code returns a `CallToolResult` with `isError: true`: `permission_denied`, `unauthenticated`, `not_found`, `invalid_argument`, gateway-unavailable and plain `internal`. JSON-RPC protocol errors remain only for unknown tool names, malformed requests and thrown non-`ApiError` values.
- The text of an error result is `<code>: <message>`; the machine-readable code travels in the result `_meta` under `adhd/error`.
- `tools/list` passes `title` and `annotations` through from `Operation.tool` next to `description` / `inputSchema` / `outputSchema`.
- The trap: a consumer that `JSON.parse`s `content[0].text` of a string-returning tool receives prose. Audit the reader; do not re-quote the string.

## Context

1. `writeResult` stringifies every result: `content: [{ type: 'text', text: JSON.stringify(result) }]` (`apigen-plugin-mcp/src/lib/run.ts:329-332`). A tool that returns the string `ok` reaches the host as `"ok"` with quotes. For a wrapped CLI or an upstream MCP tool whose answer is prose, the host sees a JSON-encoded string.
2. `writeError` re-throws every error (`run.ts:335-345`) and the `CallToolRequestSchema` handler re-throws again after logging (`run.ts:707-731`). The SDK turns the throw into a JSON-RPC error, so a policy refusal arrives as a protocol error rather than a tool result the model can read.
3. The MCP specification 2025-06-18 (Tools, Error Handling) defines protocol errors (JSON-RPC) for unknown tools, invalid arguments and server errors, and tool execution errors (`isError: true`) for API failures, invalid input data and business-logic errors. Under Structured Content a tool returning structured content SHOULD also return the serialized JSON in a TextContent block.
4. The canonical error codes are five: `invalid_argument`, `unauthenticated`, `permission_denied`, `not_found`, `internal` (`apigen-base-errors/src/lib/errors.ts:24-30`).
5. "Unavailable" is not a code. The gateway raises `ApiError('internal', "host '<h>' unavailable: <reason>", detail)` with `detail.gatewayCode === 'unavailable'` (`apigen-engine-gateway/src/lib/gateway.ts:87-103`).
6. The tool list carries only `description`, `inputSchema`, `outputSchema` (`ToolListMeta`, `run.ts:146-150`; `listTools`, `run.ts:263-281`). Upstream `title` and `annotations` are dropped; the policy serve tests pin them (`entrypoint/policy/src/test/functional/s7-serve.spec.ts:72`).
7. Unknown tool names throw `new Error('Unknown tool: ...')` before any dispatch (`run.ts:689`); `s7-serve.spec.ts:124` pins `rejects.toThrow(/Unknown tool/)`.
8. INTERFACES D-04 (refusal = `permission_denied`, CLI exit 3) and D-08 (a serve refusal reaches the host as `isError: true` carrying the reason) are the contracts this ADR keeps. `adhd-policy serve` is served by `mcpPlugin.run` (adhd ADR-0017 D7), so `mcpPlugin.run` carries D-08 itself.

## Decision

### D1 — String results are raw text (BA-2)

In `writeResult`, when the dispatched result is a JavaScript `string`, emit `content: [{ type: 'text', text: result }]` and no `structuredContent`. Every other value keeps adhd ADR-0004 D1-D3. Streams keep `projectStreamMcp` (`run.ts:314-317`). This is a general apigen-plugin-mcp change for every service.

### D2 — Error channel mapping (BA-4)

`writeError` writes `raw.output` for every `ApiError`. The `CallToolRequestSchema` handler returns `raw.output` when `writeError` set it, and re-throws otherwise.

| Error | Channel | `content[0].text` | `_meta["adhd/error"]` |
| --- | --- | --- | --- |
| `ApiError('permission_denied')` | result, `isError: true` | `permission_denied: <message>` | `{ code: 'permission_denied' }` |
| `ApiError('unauthenticated')` | result, `isError: true` | `unauthenticated: <message>` | `{ code: 'unauthenticated' }` |
| `ApiError('not_found')` | result, `isError: true` | `not_found: <message>` | `{ code: 'not_found' }` |
| `ApiError('invalid_argument')` | result, `isError: true` | `invalid_argument: <message>` | `{ code: 'invalid_argument' }` |
| `ApiError('internal')` with `detail.gatewayCode === 'unavailable'` | result, `isError: true` | `unavailable: <message>` | `{ code: 'internal', gatewayCode: 'unavailable' }` |
| `ApiError('internal')` (any other detail) | result, `isError: true` | `internal: <message>` | `{ code: 'internal' }` |
| Non-`ApiError` throw | protocol (re-throw) | - | - |
| Unknown tool name | protocol (unchanged, `run.ts:689`) | - | - |
| Malformed request (SDK-level validation) | protocol (unchanged) | - | - |
| Error inside a stream after the first chunk | unchanged (`projectStreamMcp`) | - | - |

The distinction for gateway-unavailable is keyed on `detail`, because no `unavailable` code exists and none is added. The `_meta` key `adhd/error` carries the code outside the model-facing `content`.

### D3 — Tool metadata pass-through (BA-3)

`ToolListMeta` gains optional `title?: string` and `annotations?: Record<string, unknown>`. The values come from `Operation.tool` / `MountedOperation.tool` (adhd ADR-0019 D3). `listTools` includes each only when present. Extracted TS operations carry neither, so their list entries are unchanged.

### D4 — Cancellation

The handler passes the SDK request `extra.signal` into the runtime call as `signal`. The signal contract is adhd ADR-0019 D4.

### D5 — Readers of `content[0].text` (G-5)

Every in-repo reader of `content[0].text` is in scope: `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:499`, `packages/agent/agent-plugin-budget`, `entrypoint/agent-mcp`, and the `entrypoint/backlog` e2e suites. Each is audited first and edited only where a raw string breaks it (it parses the text of a string-returning tool). A reader that does not break is not edited.

### D6 — Envelope `_meta`

`run.ts:692` reads `_meta` from inside `arguments`. That behaviour is outside this ADR.

## Consequences

- An unmodified MCP host sees a policy refusal as a tool result it can show to the model, with the reason in text, for every apigen-hosted service.
- The MCP SDK client `callTool` resolves instead of rejecting for every `ApiError`. A caller that relied on a thrown JSON-RPC error handles `isError` instead.
- A consumer that `JSON.parse(content[0].text)` on a tool whose return type is `string` receives raw text. The readers listed in D5 are audited; the audit result is recorded with the segment that edits them.
- adhd ADR-0004 D6 republish order applies: apigen-engine-runtime and apigen-plugin-mcp publish before any consumer.

## Alternatives considered

- **Keep re-throwing and convert only in the policy entrypoint.** REJECTED: the fix is general in apigen-plugin-mcp.
- **Keep `invalid_argument` and plain `internal` as protocol errors.** REJECTED by the owner: every `ApiError` is a tool result the model can read; protocol errors are reserved for requests that are not tool calls.
- **Add an `unavailable` code to `ERROR_CODES`.** REJECTED: `apigen-base-errors` is unchanged and `detail.gatewayCode` already carries the distinction.
- **Put the error code in `structuredContent`.** REJECTED: adhd ADR-0004 D2 ties `structuredContent` to an object `outputSchema`, which an error result does not satisfy.

## What does NOT change

adhd ADR-0004 D1-D6 for non-string results (the flat payload, no `{result}` envelope, `structuredContent` only for an object return); the HTTP and CLI error marshals; `CLI_EXIT_CODE`; the streaming projection; the unknown-tool protocol error.

## References

- Owner decisions 2026-10-14: BA-2, BA-3, BA-4 / G-7, G-5.
- `packages/apigen/apigen-plugin-mcp/src/lib/run.ts:146-150, 263-281, 306-333, 335-345, 685-731`.
- `packages/apigen/apigen-base-errors/src/lib/errors.ts:24-30, 58-69`; `packages/apigen/apigen-engine-gateway/src/lib/gateway.ts:87-103`.
- `entrypoint/policy/src/test/functional/s7-serve.spec.ts:72, 124`.
- adhd ADR-0004; adhd ADR-0017; adhd ADR-0019.
- MCP specification 2025-06-18, Tools: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>.
