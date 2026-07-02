# apigen — family backlog

Cross-package findings for the apigen family. Package-local backlogs (e.g.
`core/BACKLOG.md`) take precedence for their own scope.

## BUG-APIGEN-CLI-001 — cli-output generator emits invalid TS identifiers for hyphenated source dirs

- **Where:** `@adhd/apigen-plugin-cli-output` (`packages/apigen/plugins/cli`), generated `cli.ts`.
- **Symptom:** the namespace identifier is derived verbatim from the source directory name; a hyphenated dir (`tmp/dispatch-cli-spike/api.ts`) generates `import * as dispatch-cli-spike_ns from …` — a TypeScript parse error (`Expected "from" but found "-"`). Found 2026-07-02 during the dispatch CLI spike; reproduced, then confirmed working from a hyphen-free dir (`tmp/dispatchcli`).
- **Why it matters:** repo convention mandates hyphenated package names, so any in-repo consumer following convention hits this on first use.
- **Fix direction:** sanitize the derived namespace to a valid identifier (camelCase or `_` for `-`) in the cli-output plugin's codegen; add a generation test with a hyphenated source dir that spawns the generated CLI (`--help`, exit code) rather than only asserting on the emitted text.
- **Status:** FIXED (2026-07-02) — sanitizeIdentifier() added in plugins/cli src/lib/generate.ts at both identifier-emission sites (schema-key strings kept verbatim); regression suite src/test/hyphenated-namespace.spec.ts (3 tests incl. a spawn-based end-to-end from a real hyphenated dir); plugin suite 22/22.

## DEBT-APIGEN-CLI-002 — generated cli.ts imports the source module by absolute path

- **Where:** same generator; first import line of generated `cli.ts`.
- **Symptom:** `import * as … from '/Users/…/tmp/dispatchcli/api.ts'` — machine-absolute path baked into the artifact. Harmless for generate-at-build-time flows (the nx `generate` executor regenerates per machine, cache-aware), but the artifact is not relocatable and diffs across machines defeat byte-identical caching expectations.
- **Fix direction:** emit a path relative to the out-dir (or copy the source module into the out-dir like the mcp generate flow does).
- **Status:** OPEN.
- **Note:** Confirmed still present 2026-07-02 in dispatch-cli's generated artifact (machine-absolute import of src/api.ts).

## BUG-APIGEN-CORE-001 — zod-contaminated $ref resolution corrupts unrelated primitive schemas (runtime crash in generated surfaces)

- **Where:** packages/apigen/core (schema extraction) and/or packages/apigen/logical (src/lib/runmode.ts encodeNode/$ref resolution).
- **Symptom:** when an apigen `source:` file transitively imports anything using zod (e.g. @adhd/dispatch-orchestrator's AgentMcpRunner → @modelcontextprotocol/sdk), ts-json-schema-generator's whole-file extraction registers zod-derived declarations into the shared definitions registry in a way that corrupts unrelated primitive entries — generated commands then crash at first invocation with `[apigen-logical] $ref "#/definitions/boolean" cannot be resolved in run-mode without a descriptor root` (also seen for "#/definitions/number"). Even functions whose own signatures never touch zod types are corrupted (dispatch-cli's calibrate, returning a simple local interface, crashes; only eligible/status — whose type graphs never reach the MCP SDK — work).
- **Why it matters:** general, silent at generate-time, runtime-crash at first use — any future source file with a transitive zod dependency hits it.
- **Fix direction:** isolate/namespace zod-internal definitions during extraction (or filter them from the shared registry), and make runmode's encodeNode fail at GENERATE time (loud) rather than run time when a $ref cannot resolve.
- **Status:** OPEN — found 2026-07-02. HIGH severity.

## DEBT-APIGEN-CLI-003 — cli-output isBoolean codegen misses anyOf-wrapped optional booleans

- **Where:** packages/apigen/plugins/cli src/lib/generate.ts (isBoolean detection).
- **Symptom:** `flag?: boolean` extracts as `anyOf: [null, boolean, boolean]` (note the duplicate boolean arm — possibly a separate ts-json-schema-generator artifact worth a look), which the strict `schemaProps[param]?.type === 'boolean'` check never matches, so the plugin emits a value-taking `--flag <flag>` instead of a presence-only boolean flag. Workaround: declare a default value (`flag = true`) instead of `?`.
- **Fix direction:** extend isBoolean detection to recognize anyOf nodes whose non-null members are all boolean.
- **Status:** OPEN — found 2026-07-02 (dispatch-cli run --dry-run).

## DEBT-APIGEN-CLI-004 — cli-output cannot express boolean false (no --no-<flag> negation)

- **Where:** packages/apigen/plugins/cli src/lib/generate.ts (boolean flag codegen).
- **Symptom:** even a clean boolean param only projects to a presence-only `--flag` (true or undefined) — false is unreachable through the generated CLI; Commander supports `--no-<flag>` natively and dispatch-cli's hand-written bin/cli.ts demonstrates it.
- **Fix direction:** when a boolean param defaults to true, emit `--no-<flag>`.
- **Status:** OPEN — found 2026-07-02.
