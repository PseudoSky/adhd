# Distribution — @adhd/apigen-core-client v0.1.0

## Public Locations

| Location | Identifier | Path / URL |
|----------|-----------|------------|
| **npm** | `@adhd/apigen-core-client` | `https://www.npmjs.com/package/@adhd/apigen-core-client` |
| **GitHub** | repo `PseudoSky/adhd` | `https://github.com/PseudoSky/adhd/tree/main/packages/apigen/apigen-core-client` |

> **npm publish configured:** `publishConfig.access: "public"` in `package.json`. Published via `nx-release-publish` target (depends on `build` + `test`).

## Publish Pipeline

1. **Build:** `npx nx build apigen-core-client` → outputs to `dist/packages/apigen/apigen-core-client/`
   - Uses `@nx/vite:build` executor
   - Main entry: `src/index.ts`
   - Includes `*.md` assets + `src/lib/*.json` assets
2. **Test:** `npx nx test apigen-core-client` (208 tests, `@nx/vite:test` executor)
3. **Publish:** `nx-release-publish` target (packageRoot: `dist/{projectRoot}`)
   - Version resolution: `git-tag`

## Freshness

| Metric | Value |
|--------|-------|
| `last_catalog_sha` | `c8e58de33e178d5680bc9a0433bf1fe15397ef04` |
| `last_catalog_at` | `2026-07-02T23:53:00-05:00` |
| `previous_catalog_sha` | `c8e58de33e178d5680bc9a0433bf1fe15397ef04` |
| `commits_since` | 0 (same commit as prior run — doc-only changes to existing catalog files) |
| Git remote | `git@github.com:PseudoSky/adhd.git` |
| Package version | `0.1.0` |
| npm access | public |
| Tests passing | 208/208 ✅ |
