---
package: '@adhd/ui-react-base-storybook'
path: /Users/nix/dev/node/adhd/packages/ui-react/ui-react-base-storybook
root: adhd
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: [{path: 'node_modules/.vite/packages/storybook', kind: cache, purpose: 'Vite build cache'}, {path: 'dist/packages/storybook', kind: unknown, purpose: 'Vite library build output'}, {path: 'node_modules/.vitest', kind: cache, purpose: 'Vitest test cache'}, {path: 'coverage/packages/storybook', kind: logs, purpose: 'Test coverage reports'}]
config_files: ['tsconfig.lib.json']
supported_by_env: no
gaps: []
value: low
effort: high
recommend: skip
---

## Current state

- **Env vars:** none read
- **Config files:** `tsconfig.lib.json` referenced by vite.config.ts; no runtime config
- **Writes:** 
  - `node_modules/.vite/packages/storybook` (cacheDir) — Vite build cache
  - `dist/packages/storybook` (outDir) — build output
  - `node_modules/.vitest` — test cache
  - `coverage/packages/storybook` — coverage reports
- **Scope behavior:** All paths hardcoded relative to `__dirname`; zero dynamic configuration

This is a **build-time Storybook configuration package** with **zero runtime footprint**. The vite.config.ts file is a build-time module bundling spec, not a runtime service. No env vars, no server, no persistence, no state — purely compilation configuration executed at build time.

## Proposed `EnvironmentSpec`

Not applicable. Browser platform, build-only package with no Node runtime env/fs/config surface.

## Gap detail

No gaps. Package has no runtime configuration surface to migrate.

## File-location table

| Current path | Kind | Purpose | Proposed env.paths/env.files key |
|---|---|---|---|
| node_modules/.vite/packages/storybook | cache | Vite build cache | (skip) |
| dist/packages/storybook | unknown | Build output | (skip) |
| node_modules/.vitest | cache | Test cache | (skip) |
| coverage/packages/storybook | logs | Coverage reports | (skip) |
