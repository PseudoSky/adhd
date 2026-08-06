# @adhd/workspace-base-vite-paths

Dynamic, move-safe path helpers for `vite.config.ts` files across the
monorepo. Replaces hand-authored literal `cacheDir` / `reportsDirectory`
paths (which silently go stale the moment a package is `git mv`'d to a new
domain folder) with derived paths that are always correct relative to the
current location of the package on disk.

`pkg-kind:base`, `platform:node` — this package only runs inside a
`vite.config.ts` under Node during the build/test process; it is never
bundled into browser output.

## The `__dirname` contract

Every exported function takes exactly one argument: the **calling
`vite.config.ts`'s own `__dirname`**. This is the sole supported call site
for this package — do not pass any other path.

```ts
// vite.config.ts
import { projectCacheDir, projectCoverage } from '@adhd/workspace-base-vite-paths';

export default defineConfig({
  cacheDir: projectCacheDir(__dirname),
  test: {
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
    },
  },
});
```

Because the path is *derived* from `__dirname` at the moment Vite evaluates
the config, moving the package (`git mv packages/<domain>/<old> packages/<new-domain>/<new>`
+ updating the one `project.json`/`tsconfig` path-alias entry) requires
**zero edits** to `vite.config.ts` — the next `vite`/`vitest` invocation
re-resolves the workspace root and the package's relative position inside
it automatically.

## API

- **`findWorkspaceRoot(fromDir: string): string`** — walks `fromDir` upward
  via `path.dirname` until it finds a directory containing `nx.json` (the Nx
  workspace root marker). Throws a descriptive error if it reaches the
  filesystem root without finding one.
- **`projectCacheDir(fromDir: string): string`** — `<workspaceRoot>/node_modules/.vite/<fromDir relative to workspaceRoot>`.
  Use for Vite's `cacheDir` option.
- **`projectCoverage(fromDir: string): string`** — `<workspaceRoot>/coverage/<fromDir relative to workspaceRoot>`.
  Use for Vitest's `test.coverage.reportsDirectory` option.
- **`projectDist(fromDir: string): string`** — `<fromDir>/dist`. Already
  package-relative (not workspace-root-relative), so it was already
  move-safe; exported for API completeness/consistency only — no behavior
  change is implied by adopting it.
- **`workspaceNodeModules(fromDir: string): string`** — `<workspaceRoot>/node_modules`.

All five functions are pure, synchronous, and depend only on `node:fs` +
`node:path` — deliberately **no** `@nx/devkit` import, since `vite.config.ts`
is evaluated directly under Node at build/test time, outside of any
nx-devkit `Tree`/generator context.

## Building

Run `nx build workspace-base-vite-paths` to build the library.

## Running unit tests

Run `nx test workspace-base-vite-paths` to execute the unit tests via [Vitest](https://vitest.dev/).
