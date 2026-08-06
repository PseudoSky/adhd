# @adhd/workspace-base-standard

Platform-agnostic (pure `node:fs`/`node:path`, zero `@nx/devkit` import)
checkers and provenance schema/validator for the adhd monorepo's
per-package "workspace standard": required docs, required Nx targets,
per-package metadata (`.adhd/meta.json`), idempotent managed-region
upgrades, and commit/CHANGELOG provenance trailers.

```bash
npm install @adhd/workspace-base-standard
```

## Why this package exists

Every package in this monorepo is expected to converge on a shared set of
docs (`README.md`, `CLAUDE.md`, `DEMO.md`, `CHANGELOG.md`, `PLAYBOOK.md`)
and Nx targets (`build`, `lint`, `test`, `typecheck`, `demo`, `verify`, plus
`nx-release-publish` for anything published). This package is the
**platform-agnostic core** of that standard: it defines what "compliant"
means and can check any project directory against it, without depending on
Nx's project graph, `@nx/devkit`, or shelling out to any CLI. That makes it
safe to run from a git hook, a plain Node script, an MCP tool, or a unit
test — not just from inside an Nx generator/executor.

The Nx-specific wiring (actually running these checks as an Nx target,
reading tags from the real project graph, auto-fixing drift) is a
**separate** package (`PKG-WS-NX-ADAPTER`) that depends on this one. This
package never imports `@nx/devkit` and never shells out — see each module's
own doc comment for the specific boundary it holds.

## Module boundaries

| Module | Responsibility | Boundary |
|---|---|---|
| `taxonomy.ts` | Reads `.adhd/workspace.json` (the workspace's group/kind/platform/layer taxonomy, plus the new optional `boundaries.depConstraints` matrix). | Pure `node:fs` + `JSON.parse`. Mirrors (does not duplicate the format of) `workspace-codegen-nx`'s `WorkspaceConfig` reader. |
| `metadata.ts` | Reads and validates `<pkg>/.adhd/meta.json` — a new, opt-in per-package metadata block (`group`, `kind`, `concerns`, `invariants`, `entrypoints`). | Pure `node:fs`. Field names match the real `.adhd/workspace.json` vocabulary (`groups`/`kinds`), not any competing naming. |
| `required.ts` | The required-targets / required-files **registry**, as plain data. | Zero runner wiring — no target execution, no shelling out. That's the Nx adapter's job. |
| `checker.ts` | `checkProject(projectDir, tags, opts)` — checks a real project directory against the registry in `required.ts`. | Pure filesystem reads. Reads `project.json` as plain JSON (no `@nx/devkit`), so it can see declared targets but not Nx-plugin-inferred ones — see the module doc comment. |
| `managed-region.ts` | Idempotent "managed region" marker engine (`<!-- @workspace:managed:start/end id="..." -->`) for re-stamping a span of a hand-maintained file without clobbering the rest. | Pure string manipulation, no I/O. |
| `provenance.ts` | Commit-trailer parsing (`Work-Item`/`Dispatcher`/`Author`/`Model`), CHANGELOG provenance-note rendering/parsing, and pure author-identity resolution. | `resolveAuthorIdentity` takes already-gathered inputs — it never reads `process.env`, the filesystem, or shells out to `git`. Gathering those inputs is the caller's job. |

## Public API

```ts
import {
  // taxonomy.ts
  readTaxonomy, type WorkspaceTaxonomy, type DepConstraint,
  // metadata.ts
  readPackageMeta, validatePackageMeta, type PackageMeta,
  // required.ts
  REQUIRED_TARGETS, requiredTargetsFor, REQUIRED_FILES, requiredFilesFor,
  REQUIRED_FILE_SECTION_MARKERS, type RequiredTarget, type RequiredFile, type SectionRequirement,
  // checker.ts
  checkProject, type CheckResult, type CheckProjectOptions,
  // managed-region.ts
  applyManagedRegion, hasManagedRegion,
  // provenance.ts
  parseCommitTrailers, renderChangelogProvenanceNote, parseChangelogProvenanceNote,
  resolveAuthorIdentity,
  type ProvenanceTrailer, type AuthorIdentity, type ResolveAuthorIdentityInput,
} from '@adhd/workspace-base-standard';
```

### `readTaxonomy(rootDir: string): WorkspaceTaxonomy`

Reads and parses `<rootDir>/.adhd/workspace.json`. Throws if the file is
missing or malformed — a checker/CLI context should fail loudly on a broken
workspace config rather than silently skip validation.

### `readPackageMeta(pkgDir: string): PackageMeta | null`

Reads `<pkgDir>/.adhd/meta.json`. Returns `null` if the file doesn't exist
(metadata is opt-in); throws on malformed JSON.

### `validatePackageMeta(meta, taxonomy): string[]`

Returns human-readable error strings (empty array = valid) checking
`meta.group` and `meta.kind` are keys of the taxonomy's `groups`/`kinds`.

### `checkProject(projectDir: string, tags: string[], opts?): CheckResult[]`

Runs every required-file, required-section, and required-target check
against a real, absolute project directory. `opts.mode` (`'dev'` default,
or `'ci'`) controls whether an unmodified generator placeholder is a
`warn` or an `error`.

### `applyManagedRegion(content, markerId, newBody): string` / `hasManagedRegion(content, markerId): boolean`

Insert-or-replace a managed region between
`<!-- @workspace:managed:start id="<id>" -->` /
`<!-- @workspace:managed:end id="<id>" -->` markers. Everything outside the
markers is left untouched, byte-for-byte.

### `parseCommitTrailers(commitMessage): ProvenanceTrailer | null`

Parses `Work-Item:`/`Dispatcher:`/`Author:`/`Model:` trailer lines from the
last blank-line-delimited block of a commit message. Returns `null` unless
both mandatory fields (`Work-Item`, `Author`) are present and `Work-Item`
matches `^(plan:|backlog:|oneoff)`.

### `renderChangelogProvenanceNote(t): string` / `parseChangelogProvenanceNote(line): ProvenanceTrailer | null`

Render/parse the literal CHANGELOG provenance-note format:
`‹work:<workItem> · dispatcher:<dispatcher|unknown> · author:<author> · model:<model|n/a>›`.

### `resolveAuthorIdentity(input): AuthorIdentity`

Pure resolution of an agent/human author identity from already-gathered
inputs (env var value, spec frontmatter, git author name). Never touches
`process.env`/`fs`/`child_process` itself.

## Invariants

See `CLAUDE.md`'s `## Invariants` section for the enforced guarantees this
package holds (zero `@nx/devkit` import, pure filesystem reads, no shelling
out, `resolveAuthorIdentity` purity).
