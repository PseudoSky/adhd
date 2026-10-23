# stealth-search host naming and parsing decision

Plan state `search-hosts` · ticket 8468f7b1 · criteria search-hosts.4, .7, .8, .23.

The decisions below were measured on the built output of `entrypoint/stealth-search`
(`node dist/bin/cli.js --help`, and `tools/list` of `node dist/bin/mcp.js` over stdio), not assumed.

## Names

CLI-STYLE: camelCase

MCP-NAMES: stealth_search stealth_listProviders stealth_describeProvider stealth_tripwireStatus stealth_clearTripwire stealth_getPageContext stealth_chromeStatus stealth_launchChrome stealth_shutdownChrome stealth_listPageTargets stealth_checkChromeActivity

The apigen namespace is `stealth`, the file segment is dropped, and each verb is kept as ONE naming
word (`server.ts` `keepVerbWhole`). The naming authority would otherwise split `listProviders` into
the words `list` and `providers` and project `stealth_list_providers` on MCP and `list-providers`
on the CLI. Keeping the verb whole makes the CLI operation and the MCP suffix the exact function
name of `src/api.ts`, so one spelling is documented, typed and typed again by an agent.

U1: resolved

U1 (the CLI verb style) is settled by the measurement above: the built `--help` lists the eleven
operations by their camelCase function names.

U2: resolved

U2 (the MCP tool names) is settled by the measurement above: the built `tools/list` returns exactly
the eleven names of MCP-NAMES, every description is at least 40 characters, and the `launchChrome`
schema carries only `port` and `userDataDir`.

## Host-flag parsing

O12: commander

`cliPlugin.run` does not parse host flags. It reads one flag table, derived from the schema of the
operation it routes (`--input <json>`), and answers any other `--flag` with `Unknown option`. The
host flags (`--cdp-port`, `--transport`, `--idle-shutdown`, ...) are a second, operation-independent
table that is needed before an operation is chosen (for `--help`, for the MCP host that has no
operation at all, and to fill `host` and `port` of the chosen operation). A parser that owns that
table, renders its defaults in `--help` from one typed list and reports a bad value as
`HOST_FLAG_INVALID` is therefore needed, and `commander` stays a dependency of the entrypoint.
Methods used: `Command`, `.argument`, `.option`, `.exitOverride`, `.allowUnknownOption`,
`.configureOutput`, `.parse` and `.opts`.

COMMANDER: ^14.0.3

The source repository declares `^15.0.0`, but commander 15 requires Node >= 22.12 while
stealth-search supports Node >= 22.5 (search-hosts.9, preflight in both bins), and the workspace
pins commander 14.0.3 (`pnpm-lock.yaml`). The ported CLI uses only `Command`, `.argument`,
`.option`, `.parse` and `.opts`, identical in both majors, so nothing is lost by staying on ^14.0.3.

## Other measured facts the hosts rely on

- The apigen `mcpPlugin` re-throws a failed tool call as a JSON-RPC error and has no `isError` result channel. A failure is therefore an error response (a rejected `launchChrome` with `extraArgs` is `-32603 Validation failed: unknown key 'extraArgs'`), and a `hitl` search outcome is data in a normal result.
- The extraction of the eleven operations from `dist/api.d.ts` costs seconds (a TypeScript program), so both hosts keep the extracted operations in `<data-dir>/cache/operations.json` under a key of the declaration text and the extractor and core versions.
- `launchChrome` is hardened in the host copy of the composed schema: `data.input` is required, so an empty or flat call is rejected before the function runs (the function would otherwise start a Chrome with default arguments).
