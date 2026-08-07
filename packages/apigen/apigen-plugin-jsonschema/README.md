# @adhd/apigen-plugin-jsonschema

apigen target plugin (`--type jsonschema`) — emits the **JSON Schema** for each export's
input/output to disk. A **generate-only** plugin (no `run` mode); useful for validation,
docs, client generation, or as the IR other tools consume.

Part of [apigen](../../README.md). Driven via [`@adhd/apigen-cli`](../../cli).

```bash
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

apigen generate --source ./api.ts --type jsonschema --out-dir ./out   # → out/*.json
```

The schemas are the same IR the other plugins consume (params object with the `data` wrapper,
`ctx` excluded, plus any middleware envelope fields) — so what you validate against is exactly
what the MCP/HTTP/CLI targets dispatch.
