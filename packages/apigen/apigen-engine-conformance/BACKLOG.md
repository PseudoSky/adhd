### BUG-APIGEN-045 — `apigen-conformance:build` failed with TS1343 (`import.meta` under module=commonjs) — RESOLVED 2026-07-02

**Status:** RESOLVED

(Renumbered from BUG-APIGEN-018, whose id was reused by a distinct apigen-cli bug that a
prior supersede tombstoned as BUG-APIGEN-044 — `DEBT-BACKLOG-DUPLICATE-ID-INSOURCE-001`.)

`gate.ts`'s `main()` used `import.meta.url` for its ESM path fallback, but the package
type-checks under `module: commonjs`, where TypeScript rejects the syntax outright —
the build target could not compile at all. Replaced with a `findWorkspaceRoot()` walk-up
(to the first ancestor containing `nx.json`) from `__dirname`/cwd. Verified:
`npx nx run apigen-conformance:build` exit 0.

**Citations:** [/Users/nix/dev/node/adhd/packages/apigen/apigen-engine-conformance/BACKLOG.md]
