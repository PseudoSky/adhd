# @adhd/apigen-plugin-cli-output

apigen target plugin (`--type cli`) — emits a runnable **Commander CLI** (`cli.ts`) with one
subcommand per export, and can also **run live** (in-process, one command per invocation)
without ever writing that file to disk. The emitted `cli.ts` calls `dispatch` from
[`@adhd/apigen-engine-runtime`](../apigen-engine-runtime).

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../../entrypoint/apigen-cli).

## generate — emit a standalone `cli.ts`

```bash
apigen generate --source ./api.ts --type cli --out-dir ./out   # → out/cli.ts
node ./out/cli.ts getUser --user-id abc                         # or: npx tsx ./out/cli.ts …
```

Each export becomes a `.command('<fn>')`; required params → `.requiredOption`, optional →
`.option`, booleans → flag form. Middleware-contributed envelope fields (e.g. `session`)
surface as flags (`--session <key>`). Subcommand stdout is the JSON result of the call.

## run — execute the CLI surface live, no generated file

```bash
# Native positional passthrough (preferred) — everything after `--` is the
# command + its args, addressed by the naming authority's nested kebab path
# (`@adhd/apigen-engine-naming`'s `project(op).cli.path` — namespace + export
# segments), matching the CLI's real, extracted operations:
apigen run --source ./api.ts --type cli --namespace api -- getUser --user-id abc

# Equivalent, older delivery mechanism (still supported for back-compat):
apigen run --source ./api.ts --type cli --namespace api \
  --opt 'argv=api getUser --user-id abc'
```

`run()` reads its argv from `input.options['argv']` — a real `string[]` (populated natively
from a trailing `-- <command> <args>` positional passthrough by `apigen run`/`run-registry`,
or via the programmatic `@adhd/apigen-core-client` API:
`cliPlugin.run({ options: { argv: [...] } })`) or a shell-tokenized `string` (the `--opt
argv=…` delivery shown above — kept for back-compat; the native `--` form takes precedence
when both are supplied). Absent, it falls back to the real process's own
`process.argv.slice(2)` — the right default when this plugin's `run()` *is* the whole
process (a small dedicated wrapper script).

Flags follow the same conventions as `generate()`'s emitted program: kebab-case domain
params (`--user-id`), boolean flags with universal `--no-<flag>` negation, §9.1 envelope
fields as `--<pluginId>-<field>` (falling back to the bound `APIGEN_<PLUGINID>_<FIELD>` env
var), and array/object-typed params JSON-parsed from their raw argv string. Input is
validated by the same `makeValidateLayer` + `createInvoker` stack every transport plugin
uses — a malformed call is rejected as `ApiError{invalid_argument}` **before** the target
function ever runs. The result prints as single-line canonical JSON to stdout; a failure
prints `ApiError.toJSON()` to stderr and exits with the code from
`@adhd/apigen-base-errors`'s `CLI_EXIT_CODE` table (`invalid_argument`→2,
`unauthenticated`/`permission_denied`→3, `not_found`→4, `internal`→1). `--help` (bare, or
after a resolved command) prints the live command listing / that command's params, derived
from the actual schemas — never hardcoded.

`DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001` (repo root `BACKLOG.md`/`CHANGELOG.md`) is
RESOLVED: `apigen run`/`run-registry` declare a trailing variadic argument, so the native
`-- <command> <args>` form above works end-to-end against the real built bin.
