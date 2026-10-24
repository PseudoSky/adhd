# Distribution: @adhd/stealth-search

## Locations (derived from manifests and workflows only; no web crawl)
- npm: package `@adhd/stealth-search`, `publishConfig.access: public` (entrypoint/stealth-search/package.json). Bins: `stealth-search` -> dist/bin/cli.js, `stealth-search-mcp` -> dist/bin/mcp.js. `files`: dist, CHANGELOG.md. License MIT. Engines: node >= 22.5.
- Source: GitHub `PseudoSky/adhd`, directory `entrypoint/stealth-search` (package.json `repository`, `homepage`, `bugs`).
- No Docker image, docs site or other registry found in the scope's manifests.

## Pipeline
- Build: `pnpm nx run stealth-search:build` (vite, emits dist/index.js, d.ts) then `pnpm nx run stealth-search:build-bin` (tsc for bin/ and src/ into dist/bin and dist/src, then scripts/bake-operations.mjs writes dist/operations.baked.json with 11 operations). Verified this run: build-bin exit 0 (22 of 23 tasks from cache) and dist/bin/{cli,mcp}.js present.
- Gate before publish: `nx run stealth-search:verify-dist-load`, `:test` (80 files, 949 tests pass, exit 0 this run).
- Publish: project.json target `nx-release-publish`; release versioning via git-tag resolver (`release.version.currentVersionResolver: git-tag`). The workflow file that invokes it was not located within this scope; not verified.
- Format: CommonJS only (ADR-0003).

## Freshness
- Catalog run: `last_catalog_sha` = 3537748eb79c7303f62efa5caeb4c64603d3a1b5, `last_catalog_at` = 2026-10-24T14:27:31-04:00 (commit time of HEAD).
- `commits_since`: 0 (first catalog run for this scope; no prior value).
- Published npm version vs HEAD: not checked (no network lookup allowed). package.json version 0.1.0; CHANGELOG `[0.1.0]` is undated.
