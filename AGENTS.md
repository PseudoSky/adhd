## Package Scaffolding — Use `@adhd/workspace-codegen-nx` Generator

**ALWAYS use `@adhd/workspace-codegen-nx` generators to scaffold new packages.** Never use `@nx/js:library`, `@nx/vite:lib`, or any other generic Nx generator — they produce incorrect project.json, tags, and Nx configuration for this monorepo.

### Generator types (from `packages/workspace/workspace-codegen-nx/`)

| Layer | Command | Usage |
|-------|---------|-------|
| **types** | `nx g @adhd/workspace-codegen-nx:types --group <domain> --name <name>` | Pure type/contract packages (zero deps, `access:public`) |
| **base** | `nx g @adhd/workspace-codegen-nx:base --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Zero internal deps, roots of dep graph |
| **core** | `nx g @adhd/workspace-codegen-nx:core --group <domain> --name <name> --nxLayer <layer> --platform <platform> [--access public] [--publish true]` | Depends only on base packages |
| **engine** | `nx g @adhd/workspace-codegen-nx:engine --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Orchestration/wiring (depends on base + core) |
| **store** | `nx g @adhd/workspace-codegen-nx:store --group <domain> --name <name> --nxLayer <layer> --platform <platform>` | Persistence/storage (depends on base + core) |
| **entrypoint** | `nx g @adhd/workspace-codegen-nx:entrypoint --name <name> --nxLayer entrypoints --platform node [--access public] [--publish true]` | CLI/server/runner (lives under `entrypoint/`, not `packages/`) |

### Naming convention

Packages follow `<domain>-<layer>-<name>` and live at `packages/<domain>/<domain>-<layer>-<name>/`. Entrypoints live at `entrypoint/<name>/`.

### Non-JS packages (Python, Rust)

No Nx generator exists. Create manually with:
- `project.json` using `command` targets (not `executor`)
- `inputs` referencing `namedInputs` in `nx.json`
- `"externalDependencies": []` in inputs to prevent pnpm-lock cross-contamination
- `nx-release-publish` target for publishing

### Python-specific
- Plugin: `@nxlv/python` — provides `@nxlv/python:build`, `@nxlv/python:publish` executors
- Lint: `ruff`, test: `pytest`
- Publish: `@nxlv/python:publish` executor with `versionActions: "@nxlv/python/release/version-actions"`

### Rust-specific
- Plugin: `@monodon/rust` — provides `@monodon/rust:build`, `@monodon/rust:test`, `@monodon/rust:lint` executors
- Publish: custom `nx-release-publish` target running `cargo publish`
- Versioning: `useLegacyVersioning: true` in nx.json

## Lint Responsibility

- **MUST fix all lint warnings** in every file you modify. Run `npx nx lint <project>` after changes to verify.
- **Pattern for bulk lint fixes:** `no-explicit-any` → replace `: any` with `: unknown`, `as any` with `as unknown`. `no-non-null-assertion` → add `if (!x) throw` guard before `!` access. `no-unused-vars` → prefix unused name with `_`.
- **When a lint fix would change behavior** (e.g., `react-hooks/exhaustive-deps` where adding the dep causes a TS error), add `// eslint-disable-next-line <rule>` above the offending line with a comment explaining why.
- **`package.json` deps are auto-derived — do NOT hand-maintain them.** The pre-commit hook (`.githooks/pre-commit`) runs `nx affected -t lint --fix --skip-nx-cache` on staged changes and re-stages what it rewrites. `@nx/dependency-checks` (base ESLint config, `error`-level) derives each package's `dependencies` from its actual imports, so adding/removing an `import` and committing (or running `npx nx lint <project> --fix`) updates `package.json` for you; CI blocks on any unfixable lint. `--skip-nx-cache` is load-bearing — on a cache hit nx would replay the pass without re-applying the fix. See [`.githooks/README.md`](./.githooks/README.md).

## Build & Type-Checking — NEVER run `tsc` directly

- **BANNED: `tsc`, `tsc -b`, `tsc --build`, or any bare `tsc` invocation.** Always go through the Nx executor — `npx nx build <project>` to compile, `npx nx typecheck <project>` to check types. Same for isolating a single type error: use `npx nx typecheck <project>`, never bare `tsc`.
- **Why it's banned:** each package's base `tsconfig.json` sets no `outDir` (only `tsconfig.lib.json` does). Raw `tsc -b` therefore emits compiled `.js` / `.d.ts` / `.js.map` / `.d.ts.map` / `tsconfig.tsbuildinfo` **directly into `src/`**, next to the real source — polluting the tree and breaking lint. One diagnostic `tsc -b` misfire produced **331 stray untracked files across 8 packages** in a single incident. The Nx executor respects the `outDir` split and emits only to `dist/`.
- If you genuinely believe a direct `tsc` run is required, **stop and ask a human** — do not run it to "just check something."

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **adhd** (23271 symbols, 35246 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- **NEVER run `git reset --hard`.** It silently and irrecoverably destroys uncommitted work, including work belonging to other agents running concurrently in this repo. This has already happened here: a hard reset wiped five in-flight test fixes and reverted an uncommitted compiler fix, which then resurfaced as a "new" build failure. There is no undo — the discarded changes were never in the object database.
- NEVER run `git checkout -- .`, `git restore` over a whole directory/tree, or `git clean -f` — same failure mode, same lack of recovery.
- NEVER run `git stash` / `git stash pop` — it corrupts the nx project graph in this repo.
- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

### Never discard changes you did not author — surface them

**Default: you may not discard uncommitted changes.** A dirty file you did not create this
session belongs to someone else — another agent working concurrently, or the user. Deleting,
reverting, resetting, or stashing it destroys their work. When uncommitted changes are in your
way (e.g. they block a merge or a checkout), the answer is **never** to discard them — it is to
**stop and surface them to the user for resolution**, or to preserve them (commit to a branch,
or `git diff HEAD > /tmp/<name>.patch`) so nothing is lost. This has already cost real work here:
a hard reset wiped five in-flight test fixes, and a bare `git stash` swept every concurrent
agent's changes into one orphaned snapshot.

You may only discard changes that are **unambiguously your own scratch, created this session** —
and even then, preserve first if there is any doubt.

| Situation | Do | Never |
|---|---|---|
| A dirty file you didn't author is in your way | **stop and surface it to the user**; or preserve it (branch/patch) | discard it to "get a clean tree" |
| Drop **your own** one-file scratch edit | `git restore <path>` (single, explicit path) | `git restore .` / `git checkout -- .` over a tree |
| Move HEAD, keep the working tree | `git reset --soft <ref>` | `git reset --hard <ref>` |
| Need a pristine tree to build/inspect | a worktree under `.worktrees/` | resetting/cleaning the shared tree |
| Set work aside before a risky op | commit it, or `git diff HEAD > /tmp/<name>.patch` | `git stash` |

If you believe a hard reset — or discarding anyone's uncommitted work — is genuinely required,
**stop and ask a human.** Assume another agent has unsaved work in this tree, because it usually does.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/adhd/context` | Codebase overview, check index freshness |
| `gitnexus://repo/adhd/clusters` | All functional areas |
| `gitnexus://repo/adhd/processes` | All execution flows |
| `gitnexus://repo/adhd/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
