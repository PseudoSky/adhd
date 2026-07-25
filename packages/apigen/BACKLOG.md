### DEBT-APIGEN-CLI-002 — generated cli.ts imports the source module by absolute path

**Status:** OPEN

- **Where:** same generator; first import line of generated `cli.ts`.
- **Symptom:** `import * as … from '/Users/…/tmp/dispatchcli/api.ts'` — machine-absolute path baked into the artifact. Harmless for generate-at-build-time flows (the nx `generate` executor regenerates per machine, cache-aware), but the artifact is not relocatable and diffs across machines defeat byte-identical caching expectations.
- **Fix direction:** emit a path relative to the out-dir (or copy the source module into the out-dir like the mcp generate flow does).
- **Status:** OPEN.
- **Note:** Confirmed still present 2026-07-02 in dispatch-cli's generated artifact (machine-absolute import of src/api.ts).

### BUG-APIGEN-PLUGIN-PROJECTJSON-TSCONFIG-001 — 4 apigen-plugin-* build targets 500 when run from a non-root cwd (missing tsConfig in project.json)

**Status:** OPEN

Running vitest/build from entrypoint/backlog (not repo root) 500s on 4 sibling apigen-plugin-* build targets because their project.json build target omits an explicit tsConfig and relies on a cwd-relative path. Add explicit tsConfig paths so targets resolve regardless of invocation cwd. Surfaced by fix-flaky-spam during backlog test runs.
