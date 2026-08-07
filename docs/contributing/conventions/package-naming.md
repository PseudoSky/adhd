# Package Naming — `<domain>-<tier>-<name>`

**Status:** active convention · **Written:** 2026-07-16

This convention is load-bearing but was undocumented until now — it is cited by
`BUG-DISPATCH-PUBLISH-001` and `docs/plan/dispatch-completion/SCOPE.md`, yet no
definition existed anywhere under `docs/`. Two separate rename waves
(`packages/ai/*` → `packages/agent/*`, and `dispatch-spec→base`/`client→core`/
`optimizer→core` in `88ed95c6`) applied it by hand, and both waves left stale plan
artifacts behind because the target grammar was tribal knowledge. This file is the
definition; cite it instead of re-deriving it from `ls`.

## Grammar

    packages/<domain>/<domain>-<tier>-<name>        →  @adhd/<domain>-<tier>-<name>

- **domain** — the subsystem folder under `packages/`: `agent`, `dispatch`, `apigen`,
  `data`, `decompile`, `environment`, `ui-react`, `workspace`.
- **tier** — the layer within the domain. See vocabulary below.
- **name** — the specific capability.

The directory name, the `package.json` `name` (minus the `@adhd/` scope), the
`tsconfig.base.json` alias, and every import specifier **must agree exactly**.
Divergence is the exact defect class of `BUG-DISPATCH-PUBLISH-001` and
`BUG-AGENTMCP-001`: it builds in-repo via tsconfig paths and is broken on publish.

## Tier vocabulary

| Tier | Meaning | Examples |
|---|---|---|
| `base` | zero-dependency types / spec | `agent-base-types`, `dispatch-base-spec` |
| `core` | pure logic, no persistence | `agent-core-policy`, `agent-core-provider`, `dispatch-core-optimizer`, `dispatch-core-client` |
| `store` | persistence / data access | `agent-store-prompts`, `agent-store-tools`, `agent-store-runtime` |
| `engine` | orchestration over stores | `agent-engine-compiler`, `agent-engine-orchestrator` |
| `serializer` | format adapters | `dispatch-serializer-json` |
| `plugin` | optional enrichment, host-loaded | `agent-plugin-budget`, `agent-plugin-sanitize` |
| `generator` | codegen | `agent-generator-plugin` |

Adding a tier is a real decision — it widens the vocabulary for every domain. Prefer
an existing tier; if none fits, the capability may not belong in `packages/` at all
(see *Where things do NOT go*).

## Entrypoints are not tiered

CLIs and hosts live under `entrypoint/`, not `packages/`, and carry no tier:

    entrypoint/agent-mcp        → @adhd/agent-mcp
    entrypoint/dispatch-cli     → @adhd/dispatch-cli
    entrypoint/apigen-cli       → @adhd/apigen-cli

## Known outlier

- `packages/dispatch/dispatch-orchestrator` — untiered; should read
  `dispatch-engine-orchestrator` to match `agent-engine-orchestrator`.
  Deliberately left as-is: `BUG-DISPATCH-PUBLISH-001` chose canonical = the real
  dir/package names ("least churn, no dir/package renames needed") because renaming
  was avoidable there. Do not "fix" this opportunistically — it would invalidate the
  live `docs/plan/dispatch-completion` reservations.

## Where things do NOT go

A new `packages/<domain>/*` entry is a **published npm artifact** — every package
under `packages/agent/` and `packages/dispatch/` sets `publishConfig` and none are
`private`. Before adding one, it must have a **consumer**.

Do not create a package for:

- **One-shot migrations / ETL.** They have zero consumers by construction and would
  be published to npm for nobody. Put durable halves in the package that owns the
  seam (e.g. DAG validation lives in `dispatch-cli`'s `validate`; publish-hygiene in
  the `@adhd/nx-build` plugin) and keep the genuinely one-shot half a temporary,
  uncommitted script.
- **Anything with no importer.** If nothing does `import` it, it is a script or an
  `entrypoint/`, not a `packages/` library.

If a library genuinely must exist but must never publish, set `private: true`
(sole precedent: `@adhd/ui-react-base-storybook`).

## Checklist for a new package

- [ ] Has at least one real importer (else: script or entrypoint)
- [ ] Domain folder exists under `packages/`
- [ ] Tier is from the vocabulary above (or the addition is justified)
- [ ] Dir name == `package.json` name == tsconfig alias == import specifier
- [ ] `project.json` tags set (`layer:*`, `platform:*` — see root `CLAUDE.md` §1–2)
- [ ] Dependency flow is downward only (`nx graph` to verify)
- [ ] Intentional publish posture: `publishConfig` (public) or `private: true`
