# @adhd/apigen-plugin-cli-output

apigen target plugin (`--type cli`) — emits a runnable **Commander CLI** (`cli.ts`) with one
subcommand per export. This is a **generate-only** plugin (no `run` mode); the emitted
`cli.ts` calls `dispatch` from [`@adhd/apigen-runtime`](../../runtime).

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

apigen generate --source ./api.ts --type cli --out-dir ./out   # → out/cli.ts
node ./out/cli.ts getUser --user-id abc                         # or: npx tsx ./out/cli.ts …
```

Each export becomes a `.command('<fn>')`; required params → `.requiredOption`, optional →
`.option`, booleans → flag form. Middleware-contributed envelope fields (e.g. `session`)
surface as flags (`--session <key>`). Subcommand stdout is the JSON result of the call.
