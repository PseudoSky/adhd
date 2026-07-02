# apigen — family backlog

Cross-package findings for the apigen family. Package-local backlogs (e.g.
`core/BACKLOG.md`) take precedence for their own scope.

## BUG-APIGEN-CLI-001 — cli-output generator emits invalid TS identifiers for hyphenated source dirs

- **Where:** `@adhd/apigen-plugin-cli-output` (`packages/apigen/plugins/cli`), generated `cli.ts`.
- **Symptom:** the namespace identifier is derived verbatim from the source directory name; a hyphenated dir (`tmp/dispatch-cli-spike/api.ts`) generates `import * as dispatch-cli-spike_ns from …` — a TypeScript parse error (`Expected "from" but found "-"`). Found 2026-07-02 during the dispatch CLI spike; reproduced, then confirmed working from a hyphen-free dir (`tmp/dispatchcli`).
- **Why it matters:** repo convention mandates hyphenated package names, so any in-repo consumer following convention hits this on first use.
- **Fix direction:** sanitize the derived namespace to a valid identifier (camelCase or `_` for `-`) in the cli-output plugin's codegen; add a generation test with a hyphenated source dir that spawns the generated CLI (`--help`, exit code) rather than only asserting on the emitted text.
- **Status:** OPEN.

## DEBT-APIGEN-CLI-002 — generated cli.ts imports the source module by absolute path

- **Where:** same generator; first import line of generated `cli.ts`.
- **Symptom:** `import * as … from '/Users/…/tmp/dispatchcli/api.ts'` — machine-absolute path baked into the artifact. Harmless for generate-at-build-time flows (the nx `generate` executor regenerates per machine, cache-aware), but the artifact is not relocatable and diffs across machines defeat byte-identical caching expectations.
- **Fix direction:** emit a path relative to the out-dir (or copy the source module into the out-dir like the mcp generate flow does).
- **Status:** OPEN.
