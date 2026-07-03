# Required Tooling — @adhd/apigen-core-client

This file catalogs verification tools that were needed but unavailable during the catalog run, leaving some capabilities unverified.

> **Status:** All capabilities were verifiable via `npx nx test apigen-core-client`. No missing tools.

## Verified Tooling

| Tool | Purpose | Status |
|------|---------|--------|
| `npx nx test apigen-core-client` | Run vitest test suite (208 tests across 10 spec files) | ✅ Available, 208/208 passed |
| `npx nx build apigen-core-client` | Build the library via `@nx/vite:build` | ✅ Configured (not executed — tests sufficient for verification) |
| `gitnexus` | Code intelligence graph for exploring extraction pipeline | ✅ Indexed at HEAD-28, re-analyzed during catalog run |
| `npx gitnexus analyze` | Re-index the repo for fresh graph | ✅ Ran successfully (23,119 nodes, 35,000 edges) |

## Capabilities Left Unverified

None. All 19 shipped capabilities are verified through the test suite. The v1 `OutputPlugin` and v2 `Plugin` interfaces are type-only contracts exercised by consumer packages (the plugin implementations), which is expected for an interface-defining library.
