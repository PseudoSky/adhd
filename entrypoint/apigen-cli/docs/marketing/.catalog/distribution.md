# Distribution — @adhd/apigen-cli

## npm Package

- **Package name:** `@adhd/apigen-cli`
- **Version:** `0.1.0`
- **Visibility:** Public (`"publishConfig": { "access": "public" }`)
- **Bin name:** `apigen` → `./index.js` (from `package.json` `bin` field)

## Entry Points

| Field | Path | Format |
|-------|------|--------|
| `main` | `./index.js` | CJS |
| `module` | `./index.mjs` | ESM |
| `typings` | `./index.d.ts` | TypeScript declarations |

## Build Artifact

- **Build output:** `dist/entrypoint/apigen-cli/` (via `@nx/vite:build`)
- **Output contents:** `index.js`, `index.mjs`, `index.d.ts`, `lib/`, `package.json`, `README.md`
- **Build command:** `npx nx build apigen-cli`

## Publishing Pipeline

- **Executor:** `@nx/js:release-publish`
- **Package root:** `dist/entrypoint/apigen-cli`
- **Depends on:** `build` + `test` targets
- **Trigger:** CI workflow (`.github/workflows/CI.yml`) — when a PR with label `publish` is merged to main, `npx nx affected -t version` + `npx nx affected -t publish` runs for affected libraries.
- **Version resolver:** Git tag (`currentVersionResolver: "git-tag"` in project.json release config)

## Freshness

- **Last catalog run commit:** `e06cd253ee609d229ba7c00e8812a822ad424880`
- **Last catalog run at:** `2026-07-03T02:36:43-05:00`
- **Commits in repo:** 1546

## Docker

The CI also has a Docker publish workflow, but the `apigen-cli` is tagged as `layer:entrypoints, projectType: library` — it is published as an npm package, not a Docker image or container application.

## Remote

- **Git remote:** `git@github.com:PseudoSky/adhd.git`
- **Monorepo location:** `entrypoint/apigen-cli/`
