# @adhd/policy (entrypoint) — package guide

Three bins (`adhd-policy`, `adhd-policy-mcp`, `adhd-policy-http`) over `@adhd/policy-core-client`. Entry files in `src/entry` only call into `src/wrapper`; the wrapper adds no policy logic.

## Wrapper verbs (`src/wrapper/verbs`)

- `run.ts`: `run bin:<cmd> -- args`. Plans the argv operation with `buildOpPlan` (transport `cli`) and dispatches it with `dispatchForPlan` through `createPackageInvoker` (tracing, attributes, policy, validate). Refusal exits 3, invalid argument 2, otherwise the child's exit code.
- `serve.ts`: `serve bin:<mcp-server> [--name alias] -- args`. Builds the gate (`gate.ts`), an MCP upstream adapter wrapped by `watchRestartBudget`, and a gateway with `maxRestarts: SERVE_MAX_RESTARTS` (5). `gateway.start()` performs the bounded `initialize` handshake; `mcpPlugin.run` then serves `adapter.operations()` on stdio (or `deps.hostTransport`) with `usePlugins` as the Layer stack and a terminal that calls `gateway.route`. The gateway is stopped in `finally`.
- `failure.ts`: `reportFailure` prints the message to stderr and maps an `ApiError` code through `CLI_EXIT_CODE` (non-`ApiError` is 1).

## Behaviour to preserve

- `serve` never falls back to argv: a handshake failure is an error and exits non-zero.
- The gateway has no exhaustion signal, so `watchRestartBudget` counts consecutive failed restart attempts after an upstream exit; at `SERVE_MAX_RESTARTS` the verb aborts `mcpPlugin.run` and throws `ApiError('internal')` (exit 1). A restart that becomes ready resets the count.
- Terminal-routed tools take flat `arguments` and return the upstream's `CallToolResult` unchanged; only a refusal or `ApiError` (BA-4, ADR-0018) or an upstream `McpError` (re-raised with its code and message) carries words to the host. Any other failure is `internal: The tool call failed.` with one stderr line naming the operation and error class, never argument values.
- `serve` spawns the upstream at startup, before any gating, to list its tools (accepted risk O-2).

## Verification

`npx nx run policy:typecheck`, `:lint`, `:typecheck-spec`, `:build`; behaviour tests in `src/test/functional` drive the verbs with the fake launcher and stub MCP upstream in `src/test/helpers`, no subprocess.
