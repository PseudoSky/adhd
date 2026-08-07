# Apigen Features — Solution Specs

**Date:** 2026-07-04

## Scope

This document covers apigen-specific features. Workspace-standard features
(FEAT-WORKSPACE-001, FEAT-CHANGE-ENFORCE-001, FEAT-PROVENANCE-001) are owned
by the authoritative plan at `docs/workspace-base/SCOPE.md` — see that
document for the core/adapter split, config schemas, post-change rules, and
provenance design. This document does not restate those decisions.

---

## FEAT-APIGEN-001: Java host (MVP)

Create `@adhd/apigen-plugin-java-javalin` at `packages/apigen/apigen-plugin-java-javalin/`.
Generates a Maven + Javalin project scaffold. Runs via `mvn exec:java`.
Java extractor deferred (source path passthrough, like py-flask).

### Key decisions
- `PluginLanguage` already includes `'java'` — no core changes
- `JAVA_COLUMN` in `hints.ts` already has scaffolded cells
- MVP: HTTP server only (Javalin), no gRPC
- Java 17+ required

### Files to create
- `package.json`, `vite.config.ts`, `project.json`, `tsconfig*.json`, `.eslintrc.json`
- `src/index.ts`, `src/lib/plugin.ts`, `src/lib/templates.ts`, `src/lib/maven.ts`
- `src/test/plugin.spec.ts`

### Implementation segments
1. Package scaffolding (clone py-flask configs)
2. Plugin core (`plugin.ts` + `index.ts`)
3. Templates + Maven integration (`templates.ts` + `maven.ts`)
4. Tests

---

## FEAT-ENV-001: @adhd/environment centralized config

Create `packages/shared/environment/`. Implements the `Configuration<TConfig, TEnv>`
class with scope resolution (env -> project -> global -> default), Zod validation,
path expansion, and namespace isolation.

### Key decisions
- Pure TS, `platform:shared`, zero external deps beyond Zod
- Config files: `.adhd/<namespace>/config.json` (project) and `~/.adhd/<org>/<namespace>/config.json` (global)
- Env vars bridge via opt-in `env` map — no automatic reading
- Path expansion handles `~` -> `$HOME` and scope-relative resolution
- Migration targets: agent-mcp, agent-plugin-budget, agent-engine-compiler

### Files to create
- Package scaffolding + `src/index.ts`
- `src/lib/types.ts`, `src/lib/configuration.ts`, `src/lib/resolution.ts`
- `src/lib/configuration.spec.ts`, `src/lib/resolution.spec.ts`

### Implementation segments
1. Package scaffolding
2. Types
3. Resolution engine + tests
4. Configuration class + tests
5. Migration of agent-mcp config

---

## FEAT-WORKSPACE-001, FEAT-CHANGE-ENFORCE-001, FEAT-PROVENANCE-001

These features are fully designed in `docs/workspace-base/SCOPE.md`. See that
document for:
- Core/adapter split: `@adhd/workspace-standard` (nx-free) + `@adhd/workspace-nx` (adapter)
- Config schemas: `.adhd/workspace.json`, `.adhd/meta.json`
- Required targets: build, lint, test, typecheck, demo, verify
- Required files: README, CLAUDE.md, DEMO.md, CHANGELOG.md, PLAYBOOK.md
- Post-change rule table (6 change/update pairs)
- Provenance: commit trailers + CHANGELOG projection
- Boundary policy as data
- Managed region markers
- Acceptance suite (4-point)
- Author identity from agent SP context
- Published from adhd

No separate implementation spec is needed — the SCOPE.md is canonical.
