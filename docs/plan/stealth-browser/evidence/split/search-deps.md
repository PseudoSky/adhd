# stealth-search dependency audit

Source files scanned: `agent-browser/search*.ts`, `fetch-*.ts`, `network-capture.ts`, `cdp-search.ts`
(command: `rg -N --no-filename -o "from '[^']+'" ...` plus `require(...)` / `import(...)`).

Bare (non-relative, non-`node:`) specifiers found:

| Specifier | Where | Disposition |
|---|---|---|
| `commander` | `search-cli.mjs`-style host imports | declared: `^14.0.3` (workspace-wide range, as `entrypoint/backlog`) |
| `turndown` | dynamic `import('turndown')` in `fetch-markdown.ts` | declared: `^7.2.4`, plus `@types/turndown` `^5.0.6` as a devDependency |
| `pdfjs-dist` | dynamic `import('pdfjs-dist/legacy/build/pdf.mjs')` in `fetch-pdf.ts` | declared: `^4.10.38` |
| `child_process` | `require('child_process')` | node builtin, nothing to declare |

Declared for the later states although the scanned files do not import them directly (the apigen hosts,
tracing, telemetry, the tripwire and the core are introduced by the port states):

`@adhd/stealth-core-browser`, `@adhd/resilience-core-tripwire`, `@adhd/sox-telemetry`,
`@adhd/apigen-core-client`, `@adhd/apigen-engine-naming`, `@adhd/apigen-engine-runtime`,
`@adhd/apigen-plugin-mcp`, `@adhd/apigen-plugin-cli-output`, `@adhd/apigen-plugin-ir-cache`,
`@adhd/apigen-plugin-tracing`, `@modelcontextprotocol/sdk`.

Intentionally unused (source repo dependencies that do not travel): `@xmldom/xmldom`, `node-html-parser`,
`xpath` (owned by `@adhd/stealth-core-browser`), `tsx` (test runner, replaced by vitest), `@eslint/js`,
`eslint`, `typescript`, `typescript-eslint`, `@types/node` (workspace-level tooling).

Workspace ranges resolve in the workspace: the core and the tripwire package are `^0.1.0` (their package
versions are `0.1.0`); no `link:` or `file:` specifier is used.
