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
