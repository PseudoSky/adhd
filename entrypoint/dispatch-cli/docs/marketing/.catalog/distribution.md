# Distribution: @adhd/dispatch-cli

## Package Identity

- **npm name:** `@adhd/dispatch-cli`
- **npm scope:** `@adhd` (public)
- **Latest published version:** `0.0.4`
- **Total published versions:** 4
- **Source repo:** `git@github.com:PseudoSky/adhd.git`
- **Working tree SHA:** `936d50dc3a4c827b29a00dcd8686ba968775cd06`
- **Commits in history:** 2222

## Published Locations

| Location | URL / Identifier | Version | Freshness |
|----------|-----------------|---------|-----------|
| npm registry | `@adhd/dispatch-cli` | 0.0.4 | Published — latest |
| GitHub source | `entrypoint/dispatch-cli/` | 936d50dc | Working tree |
| npm tarball | `https://registry.npmjs.org/@adhd/dispatch-cli/-/dispatch-cli-0.0.4.tgz` | 0.0.4 | Published |
| npm dist-tag latest | `npm view @adhd/dispatch-cli dist-tags.latest` | 0.0.4 | Published |

## Published Artifact

The npm-publishable artifact is the `dist/` directory (CI: `nx-release-publish` target).  
The `dist/package.json` contains the published metadata:

- `main`: `./index.js` (CJS entry)
- `module`: `./index.mjs` (ESM entry)
- `typings`: `./index.d.ts` (TypeScript declarations)
- **No `bin` field** — the CLI cannot be invoked via `npx` after install
- **No `files` field** in dist/package.json (inherits from root package.json: `["dist", "CHANGELOG.md"]`)

## Files Shipped (from package.json `files`)

- `dist/` (compiled library bundle)
- `CHANGELOG.md`

## Publish Pipeline

The pipeline is defined by the `nx-release-publish` target in `project.json`:

```
nx-release-publish → dependsOn: [build, test, verify-dist-load, dist-manifest, publish-hygiene]
```

- `build`: vite build → dist/
- `test`: vitest (30 tests, all pass)
- `verify-dist-load`: builds then require()/import() the real dist/ entry
- `dist-manifest`: ensures dist/package.json matches source metadata
- `publish-hygiene`: pre-publish checks
- `nx-release-publish`: runs `npm publish` from the dist/ directory

The published artifact is the dist/ directory, which vendors:
- `index.js` (CJS, 1.99 kB)
- `index.mjs` (ESM, 3.93 kB)
- `index.d.ts` (type declarations)
- `api.d.ts`, `lib/core.d.ts` (sub-module declarations)
- `CHANGELOG.md`, `README.md`, `package.json`

## Catalog Freshness

| Metric | Value |
|--------|-------|
| `last_catalog_sha` | `936d50dc3a4c827b29a00dcd8686ba968775cd06` |
| `last_catalog_at` | 2026-07-24T22:01:35-05:00 |
| `commits_since` | N/A (first catalog run) |

## Install

```bash
npm install @adhd/dispatch-cli
# or: pnpm add @adhd/dispatch-cli
```

The installed package exposes the library surface (7 async functions + core utilities) via `require('@adhd/dispatch-cli')` / `import ... from '@adhd/dispatch-cli'`.

**Limitation:** No `bin` entry exists. After npm install, the CLI cannot be invoked as `npx dispatch-cli` or `dispatch-cli`. To use the CLI from the monorepo, run:

```bash
npx tsx --tsconfig tsconfig.base.json entrypoint/dispatch-cli/bin/cli.ts <command> [options]
```

## Dependencies (published)

From npm registry (resolved at publish time):
- `@adhd/dispatch-base-spec` ^0.0.4
- `@adhd/dispatch-core-client` ^0.0.4
- `@adhd/dispatch-core-optimizer` ^0.0.4
- `@adhd/dispatch-orchestrator` ^0.0.4
- `@adhd/dispatch-serializer-json` ^0.0.4
- `@modelcontextprotocol/sdk` 1.29.0
- `commander` 14.0.3

## Maintainer

- **pseudosky** (skywinston.sk@gmail.com)
