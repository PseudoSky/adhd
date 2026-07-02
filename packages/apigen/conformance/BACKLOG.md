# BACKLOG — @adhd/apigen-conformance

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../../BACKLOG.md)
(§ *Extraction performance + memory-leak work (2026-07-02)*).

## Fixed

### BUG-APIGEN-018 — `apigen-conformance:build` failed with TS1343 (`import.meta` under module=commonjs) — RESOLVED 2026-07-02
`gate.ts`'s `main()` used `import.meta.url` for its ESM path fallback, but the package
type-checks under `module: commonjs`, where TypeScript rejects the syntax outright —
the build target could not compile at all. Replaced with a `findWorkspaceRoot()` walk-up
(to the first ancestor containing `nx.json`) from `__dirname`/cwd. Verified:
`npx nx run apigen-conformance:build` exit 0.

### `runPythonMatrix` now uses the managed interpreter — 2026-07-02
Was `spawnSync('python3', …)` from PATH; now resolves through
`@adhd/apigen-python-env`'s `ensurePythonEnv()` (venv provisioned from
`apigen-python`'s own pyproject), guaranteeing the ≥3.11 runtime the package declares.

## Open

_(none)_
