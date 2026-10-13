# Interface contracts and decisions

Shapes are normative in `spec/architect-interfaces.md` (policy types, compiled schema, core API, service ops, ctx/ports), `spec/architect-interfaces-layer.md` (Layer port and plugin) and `spec/architect-interfaces-sources.md` (sources). This file pins package boundaries, resolves the demo's UNKNOWN list, and lists the contract each ticket must satisfy. Where this file and the spec differ, this file wins.

## 1. Package contracts
| Package | Path | Tags | Runtime deps | Root exports | Bins |
|---|---|---|---|---|---|
| `@adhd/policy-core-client` | `packages/policy/policy-core-client` | `domain:policy`, `pkg-kind:core`, `layer:logic`, `platform:node`, `access:public` | `@adhd/data-query-engine`, `@adhd/environment` (+`-base-spec`), `yaml` | the service operations (object-input form, below), `createDecider`, `createPolicyCtx`, spec types, port types | none |
| `@adhd/policy` (wrapper) | `entrypoint/policy` | `layer:entrypoints`, `platform:node`, `access:public` | client, apigen cli/mcp/fastify plugins, `@adhd/apigen-plugin-policy` | none beyond `package.json` | `adhd-policy` (+ `adhd-policy-mcp`, `adhd-policy-http`) |
| `@adhd/apigen-plugin-policy` | `packages/apigen/apigen-plugin-policy` | `layer:logic`, `platform:node` | `@adhd/apigen-engine-runtime`, `@adhd/apigen-base-errors` only | default plugin, `createPolicyLayerPlugin`, port types | none |
Import edges: client → engine/environment only. Layer plugin ↛ client and client ↛ plugin (structural port; a contract test in the wrapper imports both). Wrapper → both. `exports` map of the client lists root + `package.json` only. Importing the client root starts nothing and loads no apigen/MCP/server code.

## 2. Decisions that close the demo's UNKNOWN list
| ID | Decision |
|---|---|
| D-01 (U3) | apigen operations take `ctx` as the first, schema-excluded parameter (verified: `entrypoint/backlog/src/api.ts` header; `createClient` supplies it per call). So `service/api.ts` exports `(ctx: IPolicyCtx, input) => Promise<result>` functions, and the **library entry** is `createPolicyClient(ctxOrLayers)` returning `IPolicyClient` whose methods take only `input` (object form: `client.evaluate({tool,args,attributes,runtime})`). `createMemoryCtx({layers,...})` builds a ctx with no environment. Positional `core` functions are internal (`src/core`, not importable). Demo S1 is rewritten to `createPolicyClient` in T18. |
| D-02 (U4) | Permission id is `<layer>:<n>`, `n` 0-based within that layer's `permissions` array. `IDecision.matched` lists every permission whose tool, context and args matched (allow, ask and deny), in evaluation order (layer order, then file order). |
| D-03 (U1) | Complex inputs (`args`, `attributes`, `request`, `layers`, `operations`, `options`) are JSON values. The CLI accepts whatever apigen's derived convention provides (JSON string or `@file`); T06 records the real form and T18 reconciles the demo. No hand-written flag parsing. |
| D-04 (U7) | Every refusal is `ApiError permission_denied` → exit 3: `check` on deny/ask, `run`/`serve` refused calls. Malformed input is `invalid_argument` → exit 2. |
| D-05 (U8) | `verify` returns `{ok, errors[], warnings[]}` listing **all** issues, never stops at the first. Exit 0 when `errors` is empty (warnings allowed), exit 2 when not. A policy that cannot be loaded makes every other operation fail closed with `internal` → exit 1 and a message naming the file; `check` never allows on a load failure (FC-06). |
| D-06 (U16/LC-01) | Wrapper attribute precedence: `--adhd-attributes` (JSON or `@file`) over `ADHD_POLICY_ATTRIBUTES` over none. Never merged. File sources are re-read on every call. Non-object value refuses to start (exit 2). |
| D-07 (U6) | `bin:<cmd>` argv fallback: one operation whose id is the command's basename (`touch`), input `{argv: string[], cwd: string}`; `argv` excludes the command; `cwd` is absolute. Policy `args` match against `{argv, cwd}`. `set` can only force `cwd` or whole `argv` entries by index (`argv.0`). |
| D-08 (U12) | `serve <source>` is an explicit start. For `bin:` it performs an MCP `initialize` handshake with a bounded timeout; success ⇒ stdio MCP server, extract `tools/list` to operations whose id is `<serverName>.<tool>`; failure ⇒ error (never silently falls back to argv). Denied tools stay listed (the call is refused); refusal is an MCP tool result with `isError: true` and the reason. |
| D-09 (U11) | `draft` returns `{document, yaml, inferred: [{operation, argument, kind, reason}]}`. Effect by hints: `readOnlyHint` ⇒ `allow`, `destructiveHint` ⇒ `deny`, otherwise `ask`. Arguments inferred as `path` get `_within` over `$attributes.read_roots` (read) or `write_roots` (write); the standard secret-path deny rules are included. Operation ids are used verbatim. A draft always passes `verify`. |
| D-10 (U5/U13) | Layer discovery: explicit `--spec <file>` / `layers` input, else walk up from the working directory for `workspace-policy.yaml` (stopping at the filesystem root), else the user-global `global.yaml`, else the built-in deny-all default announced on stderr. `mcp-json init [--file p]` backs up to `<file>.adhd-policy.bak` and rewrites `command`/`args`; `mcp-json --undo` restores the backup byte for byte; a second `init` is a no-op. |
| D-11 (U9) | A tool is child-creating when any permission for it reads `args.child.*`. Narrowing coverage is computed per attribute from those filters (`narrowingCovered`); an uncovered granted attribute fails closed with `rule: "uncovered"`. |
| D-12 (U10/U2) | `explain.considered` lists every permission selected by tool name, in evaluation order, with `applicable`, `contextMatched`, `argsMatched`, `substituted` (paths unmodified). CLI output is the operation's JSON result (apigen cli-output default); policy source is announced on stderr as `policy: <path or built-in>`. |
| D-13 (U14) | `_within` over an empty list is false; relative or non-normalised paths are normalised against the call `cwd` when present, else compared as given after `path.posix.normalize`; non-existent paths are compared lexically (no fs access in core); implicit AND for multi-key objects; `_is_null` is a presence check. |
| D-14 (U15) | The Layer receives its options (decider module + options) from `--use` options; if apigen hosts do not deliver them (LI-01), T07 documents the actual channel and the plugin also accepts options programmatically. |
| D-15 (OD-16) | `ask` is `permission_denied` (exit 3) until apigen has an approval result (backlog 7e7eb01d). The Layer calls an optional `IPolicyAskHandler`; with none, `ask` ⇒ deny. |
| D-16 | `IDraftOperation` is exactly the plain-data shape in `spec/architect-interfaces-sources.md` section 4 (`name`, `args[]`, `hints.readOnly`/`hints.destructive`); `IDraftOptions` adds `readRootsAttribute?`/`writeRootsAttribute?`; the result's `inferred` entries are D-09's `{operation, argument, kind, reason}`. The demo's `hints.readOnly`/`hints.destructive` are correct as written. |
| D-17 | Refusal exit code is 3 everywhere (D-04); the demo's "non-zero" wording is tightened in T18. |

## 3. Per-ticket contract checklist
- T02: every type in spec §2, §2.1, §2.2, §3, §4.2 exported from `src/spec`; two JSON Schemas (2020-12); a schema-vs-type test is a Phase C item.
- T03: `compile(layers, options?)`, `loadCompiled(json)`, `createPolicyMemo`; compile is pure, byte-deterministic (canonical JSON), never throws on user input; `PolicyLoadError`/`PolicyCompileError`.
- T04: `evaluate`, `resolve`, `explain`, `narrow` exactly as spec §4.1-4.3; evaluate never throws.
- T05: operation set of spec §5 with D-01/D-05/D-09; `IPolicyCtx` thunk (lazy); `createDecider` matches the Layer port structurally; no `process.cwd()`, no fs in core.
- T06: three entry files each ≤ ~15 lines, no logic; baked IR; bins registered.
- T07: spec `architect-interfaces-layer.md` §2-§3; failure/malformed/timeout ⇒ deny.
- T08: `bin:` source per `architect-interfaces-sources.md` with D-07/D-08; `IProcessLauncher` port injectable (default spawns); `bin` is never executed during extraction unless `serve`/`run` was invoked.
- T09: `run bin:<cmd> --spec f [--adhd-attributes x] -- args`; `serve <source> --spec f`; `mcp-json`; `--adhd-*` flags stripped before the child sees argv.

## 4. Verified facts the file specs bind to
- `Query` and `DataView` are exported from `@adhd/data-query-engine`; `new Query({where: expr}).where` is a synchronous compiled predicate `(row) => boolean` (`packages/data/data-query-engine/src/lib/query.ts:73-110`). `matches(row, expr)` is therefore `new Query({where: expr}).where!(row)`; this closes IF-01. An invalid operator throws `QueryValidationError` (`lib/errors.ts:11`) — `validateExpression` catches it.
- `Layer = (call: Call, next: Next) => Promise<LayerResult>`; `Call` carries `operation.id`, `domainArgs`, `envelope`, `transport`, `signal?` (`apigen-engine-runtime/src/lib/invoke.ts:68-128`). A `--use` plugin is `UsePlugin = {id, capabilities?: {layer?: {layer(call, next)}}}` (`package-invoker.ts:36-80`); plug-in options ride on `options.useOptions[pluginId]` (`package-invoker.ts:86`).
- `new ApiError(code, message, details?)`; `CLI_EXIT_CODE` maps codes to exit codes (`apigen-base-errors/src/lib/errors.ts:58-125`).
- The CLI is mounted with `cliPlugin.run({packages:[pkg], operations, outputDir:'', options:{argv, usePlugins, exitCode?}})` where `pkg={id,version,schemas,importPath,fns,createClient}` (`entrypoint/backlog/src/cli.ts:1007-1040`, `server.ts:630-650`). `createClient` is called fresh per dispatch.
