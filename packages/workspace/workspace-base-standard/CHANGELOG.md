## 0.0.3 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.0.2 (2026-09-24)

This was a version bump only for workspace-base-standard to align it with other projects, there were no code changes.

# Changelog

## Unreleased

### 🚀 Features

- Initial release of `@adhd/workspace-base-standard`: platform-agnostic
  (zero `@nx/devkit`, zero shell-out) checkers + provenance schema/validator
  for the monorepo's per-package workspace standard.
  - `taxonomy.ts` — `readTaxonomy(rootDir)`, mirroring
    `workspace-codegen-nx`'s `.adhd/workspace.json` reader, plus a new
    optional `boundaries.depConstraints` field.
  - `metadata.ts` — `readPackageMeta`/`validatePackageMeta` for the new
    per-package `<pkg>/.adhd/meta.json` file.
  - `required.ts` — `REQUIRED_TARGETS`/`REQUIRED_FILES` registry plus
    `requiredTargetsFor`/`requiredFilesFor` tag-aware lookups.
  - `checker.ts` — `checkProject(projectDir, tags, opts)`, a pure
    filesystem-only project standards checker.
  - `managed-region.ts` — `applyManagedRegion`/`hasManagedRegion` idempotent
    marker engine for upgrade re-application.
  - `provenance.ts` — `parseCommitTrailers`/`renderChangelogProvenanceNote`/
    `parseChangelogProvenanceNote`/`resolveAuthorIdentity` (FEAT-PROVENANCE-001).

‹work:backlog:FEAT-WORKSPACE-001 · dispatcher:plan-orchestrator · author:typescript-pro:v1 · model:claude-sonnet-5›
