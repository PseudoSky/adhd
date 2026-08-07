# Agent notes — @adhd/workspace-base-standard

This package defines the platform-agnostic core of the adhd monorepo's
per-package workspace standard. If you are an agent editing this package,
read this first.

## Invariants

- **Zero `@nx/devkit` import.** Every module in `src/` must remain loadable
  without the Nx project graph. If you need Nx-aware behavior (reading
  inferred targets, running an executor, walking the real dependency
  graph), that belongs in the (separate) Nx adapter package
  (`PKG-WS-NX-ADAPTER`), not here.
- **No shelling out.** No module here spawns a child process or invokes
  `git`/`nx`/any CLI. All state is read via `node:fs` from an absolute
  directory path passed in by the caller.
- **`resolveAuthorIdentity` is pure.** It never reads `process.env`, the
  filesystem, or `child_process` — every input it needs (`envAgentName`,
  `specFrontmatter`, `gitAuthorName`) must already be gathered by the
  caller and passed in. This keeps it unit-testable without process
  mocking; do not "helpfully" wire in an internal `process.env.SOX_AGENT_NAME`
  read.
- **`checkProject` never mutates.** It is a pure checker — it returns
  `CheckResult[]`, it never writes to the project directory it's checking.
  Auto-fixing (stamping missing files, replacing placeholders) is the Nx
  adapter's job, not this package's.
- **`.adhd/workspace.json` has exactly one reader format.** `taxonomy.ts`
  mirrors the shape already read by
  `packages/workspace/workspace-codegen-nx/src/generators/shared/workspace-config.ts`
  plus the new optional `boundaries` field. Do not invent a second,
  divergent taxonomy shape here.
- **Field-name vocabulary is `group`/`kind`**, matching
  `.adhd/workspace.json`'s real `groups`/`kinds` keys — not any competing
  `area`/`group` naming from older design docs. If you see a doc using
  `area`, that doc is stale relative to this implementation.

## Common pitfalls

- Don't add a dependency on `@adhd/workspace-codegen-nx` or any other
  `@adhd/*` package — this is a `pkg-kind:base` tier package (zero internal
  `@adhd/*` deps) by design. If you find yourself wanting to import a
  sibling package, that logic belongs in a `core`/`engine` tier package
  that depends on this one, not the other way around.
- Don't hardcode the generator's README placeholder string in more than one
  place — `checker.ts`'s `placeholderTemplateFor` is the single seam; keep
  it in sync with `workspace-codegen-nx`'s `ensureReadme` if that stamper's
  template ever changes.
