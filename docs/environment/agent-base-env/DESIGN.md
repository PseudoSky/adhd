# Design review: shared registry env resolver for the agent-registry family

**Context anchor:** `BACKLOG.md` → `FEAT-ENV-ADOPT-001` → `ENV-ADOPT-CLUSTERS(1)` (enriched at commit `a02b84b9`) and `DEBT-WORKSPACE-ARTIFACTS-001`.
**Reviewer:** architect-reviewer (design gate, no implementation performed).
**Date:** 2026-07-22.

## VERDICT: APPROVED-WITH-CHANGES

The core idea — a thin `@adhd/environment-core-node`-wrapping package + dependency injection to kill the module-top-level `new Database()` side effect — is correct and should proceed. Four changes are required before implementation, and one severity correction changes how the work should be prioritized/communicated:

1. **Rename + retier:** `agent-base-env` (tier `base`) → **`agent-core-env`** (tier `core`). Every existing `base`-tier package in the repo (6/6 sampled) has **zero** first-party `@adhd/*` dependencies; a package that depends on `@adhd/environment-core-node` breaks that invariant. `core` tier already has same-group precedent (`agent-core-provider`, `agent-core-policy` both depend on `@adhd/agent-base-types`) and is the closer fit.
2. **Layer tag:** use `--nxLayer=ai` (matching all 5 existing family packages), **not** `--nxLayer=shared` as proposed. `environment-core-node` is tagged `layer:data`; the *intended* `layer:shared` boundary rule forbids depending on `layer:data`, while `layer:ai` explicitly allows it. (The rule is currently unenforced — see Finding D — but the new package should still comply with the documented intent, not the loophole.)
3. **Trim the API surface:** drop `resolveOperationalDbPath()` from scope. Agent-mcp's own operational DB (`db.path`) is *already* correctly migrated via its own `agentMcpEnvironmentSpec` (`entrypoint/agent-mcp/src/config.ts:60-64,84-89`) — it is a different database serving a different, non-shared consumer, and does not belong in an `agent`-domain **library**. Ship only `resolveRegistryDbPath()` + `openRegistryDb()`.
4. **Severity correction:** the hazard is real but its blast radius is *narrower* than "a live correctness bug." I traced every consumer of the re-exported `{db, sqlite}` singletons and found **zero** live-server or in-process readers (Finding B). The severity is: unwanted filesystem side effects, leaked file handles, and standalone-tooling (drizzle-kit, seed scripts, generator templates) drift — not "the server operates on the wrong data." Frame the fix priority accordingly; don't over-state it as a data-correctness incident when scoping/communicating the work.

The design is otherwise sound: DI is *already* the load-bearing pattern (every store class takes `db` via constructor; `compileAgent()` takes `db` explicitly; `buildPromptResolver()` already injects one real connection) — this migration removes a now-redundant, harmful side effect, it does not introduce DI where none existed.

One item is explicitly **not resolved here and requires a human decision**: whether/how to migrate the flat legacy `~/.adhd/agent-mcp/agents.db` (48 real agent-mcp operational rows) forward. See "Open human decisions" below — this turned out to be a different database than the proposal implied, which matters for who owns the fix.

---

## Decision 1 — Tier / layer / platform / scaffold invocation

**`--group agent` is valid.** `.adhd/workspace.json` groups: `apigen, agent, data, dispatch, environment, ui-react, workspace`[1].

**Tier: `core`, not `base`.** Evidence:
- Every sampled `base`-tier package in the repo has zero first-party dependencies: `environment-base-spec`, `dispatch-base-spec`, `apigen-base-types`, `apigen-base-schema`, `apigen-base-errors`, `apigen-base-logical` — all `"adhd deps: NONE"`[2]. `.adhd/workspace.json` describes `base` as "Zero internal cross-dependencies. Roots of the dep graph."[1] — this is not aspirational text, it is the actual state of every instance.
- `agent-base-env` as proposed would be the *first* `base`-tier package in the monorepo with a real `@adhd/*` dependency. That is a correctness signal, not a style preference — an agent (or a future generator) reading the existing corpus for "what does base mean here" will conclude, correctly, that base packages don't import anything internal.
- `core`-tier packages in this exact group already do this: `agent-core-provider` and `agent-core-policy` both depend on `@adhd/agent-base-types`[3]. The shape — one focused package, one internal dependency, no orchestration — matches `core`'s own definition ("Depends only on base packages…")[1] far better.
- **New package name:** `agent-core-env` (bare name `env`, tier `core`) → `packages/agent/agent-core-env/`.

**Layer: `ai`, not `shared`.** All 5 existing family packages are tagged `layer:ai`, `platform:node`[4]. `environment-core-node` is tagged `domain:environment, pkg-kind:core, pkg-class:foundation, layer:data, platform:node, access:domain`[5]. The documented (see Decision 2 for enforcement status) `layer:ai` boundary rule allows `["layer:data","layer:shared"]`; the `layer:shared` rule allows only `["layer:shared","layer:test-logic"]`[6] — i.e. under the intended semantics, a `layer:shared`-tagged package literally cannot depend on a `layer:data` package. Tag `agent-core-env` `layer:ai` to match its siblings and to comply with intent.

**Platform: `node` — unchanged, no widening.** All 5 family packages are already `platform:node`[4]; `environment-core-node` is also `platform:node`[5]. Nothing gets newly forced into `platform:node` that wasn't already there — the review prompt's concern here doesn't materialize.

**`access`: `domain` (default), not `public`.** This is an internal implementation detail of the agent-registry cluster; no other domain needs it.

**`publish`: `true`.** The 5 family packages are themselves published (`agent-store-prompts` has a real `publishConfig` and version `2.1.2`[7]; `BUG-AGENTMCP-001`/`BUG-DISPATCH-PUBLISH-001` in `BACKLOG.md` are specifically about published-package resolution for this family). Once `agent-core-env` becomes a real `dependencies` entry of those 5 packages' `package.json`, it must itself be published or their published installs break the same way `BUG-AGENTMCP-001` describes.

**Exact invocation:**
```bash
npx nx g @adhd/workspace-codegen-nx:core \
  --name=env --group=agent \
  --nxLayer=ai --platform=node \
  --publish=true \
  --dry-run
# then, after reviewing the CREATE list:
npx nx g @adhd/workspace-codegen-nx:core \
  --name=env --group=agent \
  --nxLayer=ai --platform=node \
  --publish=true
```
(`workspace-codegen-nx:core`'s schema requires exactly `name, group, nxLayer, platform`, with `access`/`publish` optional[8] — the invocation above is complete and valid against that schema.)

---

## Decision 2 — Layering / purity: is the dependency actually allowed?

**Yes, mechanically — but the enforcement is dead code, which is itself a bug (filed).** I verified this empirically, not just by reading JSON:

```
$ npx eslint --print-config packages/agent/agent-engine-compiler/src/index.ts
...
"@nx/enforce-module-boundaries": ["error", {
  "enforceBuildableLibDependency": true,
  "allow": [],
  "depConstraints": [{ "sourceTag": "*", "onlyDependOnLibsWithTags": ["*"] }]
}]
```
This is the wildcard allow-all from `.eslintrc.base.json:112-124`, **not** the `layer:`/`platform:` `depConstraints` block declared in the repo-root `.eslintrc.json:20-99`. Root cause: every project's own `.eslintrc.json` (`packages/agent/agent-engine-compiler/.eslintrc.json:2-4`, and identically for `agent-store-prompts`, `agent-store-tools`, `agent-core-policy`, `agent-core-provider`, `agent-engine-orchestrator`, `agent-store-runtime`, `dispatch-base-spec`, `environment-core-node`) `extends` **only** `../../../.eslintrc.base.json`, which sets `"root": true`. ESLint's upward config-cascade walk stops there and never reaches the outer repo-root `.eslintrc.json`. **This means no `layer:`/`platform:` boundary rule is currently enforced for any package in the repo, regardless of what tags you pick.** Filed as `DEBT-WORKSPACE-LINT-BOUNDARIES-001` (committed this session, `BACKLOG.md`).

Given that, the tag recommendations in Decision 1 are about matching the *documented intent* (so the design survives the day someone fixes `DEBT-WORKSPACE-LINT-BOUNDARIES-001`) and about human/tooling legibility, not about avoiding an active lint failure — there isn't one either way today.

**Cross-domain dependency — a genuine first, not a violation.** I scanned every `packages/*/*/package.json` for a first-party dependency pointing outside its own domain directory: zero exist anywhere in the repo today[9]. `agent-core-env` → `@adhd/environment-core-node` would be the first. This is **not forbidden** by any doc (`AGENTS.md` §2/§8, `.adhd/workspace.json` — none mention cross-domain restrictions; §8 is about *tier* purity, not *domain* purity), and it has a partial precedent one layer up: `entrypoint/agent-mcp` (conceptually agent-domain) already imports `@adhd/environment` directly (`entrypoint/agent-mcp/src/config.ts:24`)[10] — we are extending an already-accepted relationship down into the library layer, not inventing a new one. Still, flag this explicitly for human sign-off since it's unprecedented at the `packages/` layer — see "Open human decisions."

---

## Decision 3 — THE LATENT HAZARD: who actually reads the singletons?

**Traced exhaustively. Zero live-server or in-process readers of the re-exported `{db, sqlite}` singletons.** Evidence chain:

1. **Store classes never read the singleton.** Every store class across the 5 packages (`AgentStore`, `ComponentStore`, `ComposedPromptStore`, `CompositionStore`, `UsecaseStore`, `AgentToolStore`, `BindingStore`, `McpServerStore`, `ToolStore`, `AgentPolicyStore`, `PolicyTemplateStore`, `ModelStore`, `ProviderStore`, `ToolFormatStore`) takes its DB handle via **constructor parameter** — none of their source files import `./db/client.js`[11].
2. **The compiler takes `db` as an explicit function argument.** `packages/agent/agent-engine-compiler/src/compile.ts:66,68,106,175-176`: `compileAgent(input: CompileInput)` destructures `db` from `input` and threads it into every store constructor it builds (`AgentStore`, `ToolStore`, `ToolFormatStore`, `BindingStore`, …) — it never touches a package's re-exported singleton.
3. **`buildPromptResolver()` (the real, live wiring, fixed in `8a9f77f9`) opens its own connection and injects it.** `entrypoint/agent-mcp/src/index.ts:108-140`: opens `registrySqlite = new Database(resolvedRegistryPath)` from the **env-resolved** `registryDbPath`, runs all 5 packages' migrations against that one connection (`runProviderMigrationsOn(registrySqlite, registryMigrationDb, …)` etc., all with explicit params, not reading any singleton), and this is the handle that flows into `compileAgent`'s `db` param.
4. **Direct grep for the singleton import, repo-wide (excluding tests and the `docs/plan/.../superseded/` demo script), is empty.** `grep -rn "import.*{.*\bdb\b.*}.*from '@adhd/agent-" --include="*.ts" entrypoint packages` returns nothing outside `__tests__` and the explicitly-named `superseded/` directory[12].
5. **The only thing that *does* read `./db/client.js`'s singleton internally is the bare, no-argument `runMigrations()` export** in each package's `migrate.ts` (e.g. `packages/agent/agent-store-prompts/src/db/migrate.ts:1,12`: `import { db, sqlite } from './client.js'; … runMigrationsOn(sqlite, db)`). I grepped every call site of `runMigrations()` (no `On` suffix) across the repo: the only invocation is `entrypoint/agent-mcp/src/index.ts:212`, and that resolves to **agent-mcp's own local `./db/migrate.js`** (its own operational store, imported at `index.ts:8`), not any of the 5 family packages'. **None of the 5 family packages' bare `runMigrations()` exports have any caller anywhere in the repo** — dead code, safe to delete outright as part of this change.

**Conclusion / severity correction:** this is **not** "the server is silently operating on the wrong data" — every real read/write path is already correctly DI'd to the one env-resolved connection. The actual hazard is exactly what materialized on disk during this review:
```
./data/registry.db, ./data/registry.db-wal, ./data/registry.db-shm
./data/agents.db,   ./data/agents.db-wal,   ./data/agents.db-shm
./data/agent-mcp/agents-{dev,published}.db{,-wal,-shm}
```
— gitignored (`.gitignore:53-56`) but real disk pollution at the repo root every time *anything* imports one of these 5 packages, matching `DEBT-WORKSPACE-ARTIFACTS-001` exactly[13] — plus a leaked open SQLite file handle (with WAL mode + an open connection) per process, per package, forever, for no reason. `agent-core-provider`'s divergent home-dir default has also fired for real: `~/.adhd/agent-core-provider/agents.db` exists on disk[14]. Fix priority should be framed as "kill an unnecessary, unbounded side effect + close a leak," not "fix wrong-data reads" — the latter isn't happening.

---

## Decision 4 — Canonical location, precedence, and the data-migration question

**Correction to the proposal's framing: the "48 agents" are NOT registry-family data.** I queried both databases directly:
```
~/.adhd/agent-mcp/agents.db            .tables → __drizzle_migrations, agents, composed_prompts,
                                                  experiment_assignments, messages, sessions,
                                                  task_events, task_usage, tasks
  SELECT count(*) FROM agents  → 48
.adhd/agent-mcp/production/data/agents.db (project-scope, repo root)   → same schema, count(*) FROM agents → 0
.adhd/agent-mcp/production/data/registry.db (project-scope, repo root) → registry_agents, tool_*, provider_*, policy_* (registry-family schema)
```
[15]. The flat legacy file's schema (`agents`, bare `composed_prompts` — no `registry_` prefix) is **agent-mcp's own operational schema**, not the registry family's (`registry_agents`, `registry_composed_prompts`, …). This is `db.path` (agent-mcp's `agentMcpEnvironmentSpec`), not the registry file this whole migration is about. Two consequences:
- This data-migration question belongs to agent-mcp's own environment adoption (already noted as "unproven end-to-end" in `FEAT-ENV-ADOPT-001` Step 0), **not** to `agent-core-env`'s scope — reinforcing Change #3 (drop `resolveOperationalDbPath()`).
- It is still a **live, real** gap worth surfacing precisely because it's easy to misdiagnose: the repo's own `.mcp.json` (uncommitted, in-progress — not modified by this review) sets `"ADHD_ENV_SCOPE": "project"` and an explicit `ADHD_AGENT_REGISTRY_DB_PATH` override[16], meaning **this exact live session's agent-mcp instance is pointed at the empty project-scope `agents.db` (0 rows) and the project-scope `registry.db`**, not the 48-row flat legacy file. Whoever owns that decision should know it now, not discover it later.
- Bonus wrinkle for whoever *does* pick this up: even a pure path fix wouldn't be sufficient — the flat file's bare `composed_prompts` table doesn't match the current `registry_composed_prompts`-prefixed schema, so any future reconciliation needs a real schema-aware migration, not just a path override.

**For the registry file itself (this design's actual scope), recommended canonical resolution:**
- New `Environment` identity: project id `'agent-registry'` (not `'agent-mcp'`) — this infers env-var prefix `ADHD_AGENT_REGISTRY` by the same inference rule agent-mcp's own `config.ts:16-20` documents (`"agent-mcp" → "ADHD_AGENT_MCP"`), which happens to line up exactly with the existing `ADHD_AGENT_REGISTRY_DB_PATH` convention with zero `envPrefixOverride` needed.
- `namespaces: ['production']`, `dirs: { data: { kind: 'data' } }`, `files: { registry: { in: 'data', name: 'registry.db' } }` → zero-config default resolves to `<scope-root>/agent-registry/production/data/registry.db`.
- **Recommend pinning `dirs.data.scope = 'global'` by default** (via `DirSpec.scope`[17]) rather than letting it auto-detect `project` vs `global` from the invoking cwd's `.git`/`.adhd` marker. Rationale: unlike agent-mcp's own per-deployment task/session store, the registry is a single shared catalog that the server, CLIs, seed scripts, and drizzle-kit must all agree on — letting it silently fork based on whatever directory a command happens to be run from is *exactly* how the current flat-vs-namespaced split happened. An explicit `ADHD_ENV_SCOPE=project` or `options.scope` still overrides it when real isolation (dev, CI, tests) is wanted, exactly as `.mcp.json` already does today for the registry via its explicit path override. **Flagged as an open human decision** — it's a default-behavior choice, not purely mechanical.
- **Explicit precedence in `resolveRegistryDbPath()` (highest → lowest), for full back-compat:**
  1. Function-argument override (explicit caller intent, e.g. tests).
  2. `ADHD_AGENT_REGISTRY_DB_PATH` (agent-mcp's current, `ADHD_AGENT_*`-prefixed convention — `entrypoint/agent-mcp/src/config.ts:121-124`).
  3. `REGISTRY_DATABASE_PATH` (the more specific of the two legacy family names — `agent-store-prompts/src/db/client.ts:14`, `agent-engine-compiler/src/db/client.ts:17`).
  4. `DATABASE_PATH` (the generic legacy name — all 5 clients accept it as a fallback[18]).
  5. `@adhd/environment`-resolved canonical path (the new zero-config default).
  This must live as explicit code in `resolveRegistryDbPath()`, not as a single `FieldSpec.env` mapping — `FieldSpec` only carries one explicit env name, and 3 independent legacy names must all keep working.
- **No automatic data migration as part of this change.** `resolveRegistryDbPath()` should resolve the canonical path and nothing else — it must not silently copy/rename an old file it happens to find. A separate, explicit, human-approved one-time migration (copy the existing populated `./data/registry.db` / `~/.adhd/agent-core-provider/agents.db` content into the new canonical location, verified by row counts before/after) should run once, before this lands in anything a real user depends on. See "Open human decisions."

---

## Decision 5 — File-by-file change list

**New package — `packages/agent/agent-core-env/`** (scaffolded per Decision 1):
- `src/spec.ts` — the `EnvironmentSpec` described in Decision 4 (project id `agent-registry`, `dirs.data`, `files.registry`).
- `src/resolve-registry-db-path.ts` — `resolveRegistryDbPath(opts?: { registryDbPath?: string; scope?: Scope }): string`, precedence exactly as in Decision 4, synchronous (matches `@adhd/environment`'s "live in-memory resolve, no I/O prerequisite" contract[19], so it's safely callable from `drizzle.config.ts`, which cannot `await`).
- `src/open-registry-db.ts` — `openRegistryDb(opts?): { sqlite: Database.Database; db: BetterSQLite3Database }` — a **lazy** factory (only opens on call, never at module scope), mkdir's the parent dir, sets WAL + `foreign_keys = ON` (matching every existing client's pragmas[20]), does **not** run migrations itself (that stays the caller's explicit responsibility, exactly as `buildPromptResolver()` already does today).
- `src/index.ts` — barrel exporting the above 2 functions + the spec type.
- Standard `package.json`/`project.json`/`.eslintrc.json`/`tsconfig*.json`/`vite.config.ts` from the generator, `dependencies: { "@adhd/environment-core-node": "<version>", "better-sqlite3": "12.10.0", "drizzle-orm": "0.45.2" }`.
- Tests (real, no mocks — per `AGENTS.md` §7): back-compat precedence (each of the 3 legacy env vars wins in the documented order over the canonical default; explicit arg wins over all); a **negative-control import-side-effect test** that imports `openRegistryDb`/`resolveRegistryDbPath` and asserts **no file is created merely by importing the module** (this is the exact regression this whole migration exists to prevent — it must go red if a future edit reintroduces module-top-level `new Database()`); scope-pin behavior (`global` default vs `ADHD_ENV_SCOPE=project` override) against a temp `adhdRoot`.

**Edit — each of the 5 family packages' `db/client.ts`** (`agent-store-prompts:13-28`, `agent-engine-compiler:17-19`[+31-40], `agent-store-tools:9`[+21-26], `agent-core-policy:9`[+21-26], `agent-core-provider:10`[+22-27]): **delete the file entirely.** Nothing needs it — see Decision 3 point 1 (stores take `db` via constructor) and point 5 (the only internal reader, the bare `runMigrations()`, has zero callers and is being deleted too).

**Edit — each of the 5 family packages' `db/migrate.ts`:** delete (its sole purpose, the singleton-reading `runMigrations()`, has zero callers anywhere — Decision 3 point 5).

**Edit — each of the 5 family packages' `src/index.ts`:** remove `export { sqlite, db } from './db/client.js';` and `export { runMigrations } from './db/migrate.js';`. Keep `export { runMigrationsOn, MIGRATIONS_FOLDER } from './db/migrate-runner.js';` (this is the real, explicit-param mechanism `buildPromptResolver()` already uses and must keep using) and the schema re-export.

**Edit — `drizzle.config.ts`** in `agent-store-prompts` and `agent-engine-compiler` (both currently duplicate the identical inline `REGISTRY_DATABASE_PATH || DATABASE_PATH || './data/registry.db'` logic[21]): replace `dbCredentials.url` with `resolveRegistryDbPath()` imported from `@adhd/agent-core-env`. (`agent-store-tools`, `agent-core-policy`, `agent-core-provider` have no `drizzle.config.ts` of their own today per the file listing gathered — confirm at implementation time whether they need one added or share the two existing configs' `out` folders; not altering that structure is in scope, just the URL resolution.)

**No change needed — seed scripts** (`*/src/seed/*.ts`, all 5 packages): already pure `seed(db)` functions taking an explicit parameter, no `client.js` import anywhere[22]. Note (not a blocker): I found no code anywhere in the repo that actually *calls* any of these `seed()` exports with a concrete `db` — that gap predates and is independent of this migration; worth a separate backlog item if seeding is meant to be part of a real onboarding/bootstrap flow, but it is out of scope here.

**Edit — generator templates**, `packages/agent/agent-generator-plugin/src/generators/registry-package/__files__/`:
- `src/db/client.ts__tmpl__` — currently reproduces the exact anti-pattern verbatim[23]: delete, replace with guidance in the template's own comments to import `openRegistryDb()`/`resolveRegistryDbPath()` from `@adhd/agent-core-env`.
- `src/db/migrate.ts__tmpl__` — delete for the same reason as the 5 real `migrate.ts` files.
- `src/index.ts__tmpl__` — remove the `export { sqlite, db }` and `export { runMigrations }` lines[24].
- `package.json__tmpl__` — add `@adhd/agent-core-env` as a dependency.
- No existing generator test (`generator.spec.ts`) snapshots this output today — I searched and found none[25]. Not a blocker, but add one while touching this template so a future regression here isn't silent again.

**Edit — `entrypoint/agent-mcp`:**
- `src/index.ts` `buildPromptResolver()` (lines 83-140): change the `registryDbPath` resolution (currently sourced from `env.config.server.registryDbPath`, computed in `config.ts`) to delegate to `@adhd/agent-core-env`'s `resolveRegistryDbPath()` for the *default*, while still accepting the explicit `ADHD_AGENT_REGISTRY_DB_PATH` / caller-supplied `registryDbPath` overrides exactly as today (no behavior change for the current, already-working override paths — only the *fallback* default changes, and only once the human decision on canonical location below is resolved). Optionally also switch the inline `new Database(resolvedRegistryPath)` + manual pragma setup (lines 122-124) to call `openRegistryDb()` for symmetry — low risk, since this code path is already correct; do it for consistency, not because it's broken.
- `src/config.ts` `"server.registryDbPath"` field (~line 121): its hardcoded flat default `path.join(os.homedir(), '.adhd', 'agent-mcp', 'registry.db')` is a *third*, independent resolution mechanism, decoupled from both `@adhd/environment`'s dirs/files system and the family packages' own legacy defaults. Once `agent-core-env` exists, this field's `default` should become `undefined` (field absent ⇒ let `agent-core-env`'s own default win) rather than hardcoding a competing path here — otherwise we'll have fixed 5 duplicated defaults and left this 6th one standing.

**Docs to update** (`AGENTS.md` §9 mandate: "always update relevant docs to include surface features added"):
- `packages/agent/agent-generator-plugin/REGISTRY-PACKAGE-RULES.md` — the "one shared SQLite file" invariant section should mention the new resolver package and the DI convention (no module-scope singleton) explicitly, so the next hand-authored or generated registry package doesn't reintroduce the pattern.
- The 5 packages' own `CLAUDE.md`s (where present) — same update, plus fix the broken `../agent-nx/` link found in `agent-engine-compiler/CLAUDE.md` (already filed as `BUG-AGENTMCP-DOCLINK-001`, independent one-line fix, do it in the same pass since you're touching that package anyway).
- `packages/agent/agent-engine-compiler/CLAUDE.md` and any other family `README.md` mentioning `./data/registry.db` as *the* default should be updated to describe the new canonical location.

---

## Decision 6 — Sequencing, blast radius, and risk

**Blast radius (who becomes `affected`):** the 5 family packages + their direct/transitive dependents, confirmed by grep (not `nx graph`, to avoid an unrelated build during a design-only review):
- `agent-store-prompts` ← `agent-engine-compiler`, `agent-engine-orchestrator`, `entrypoint/agent-mcp`[26]
- `agent-engine-compiler` ← `agent-store-tools`, `agent-store-prompts`, `agent-engine-orchestrator`, `entrypoint/agent-mcp` (peer dependency, per `agent-engine-orchestrator/package.json`'s `peerDependencies: {"@adhd/agent-engine-compiler": "^2.1.0"}`)[27]
- `agent-store-tools` ← `agent-engine-compiler`, `entrypoint/agent-mcp`
- `agent-core-policy` ← `agent-engine-compiler`, `entrypoint/agent-mcp`
- `agent-core-provider` ← `agent-engine-compiler`, `entrypoint/agent-mcp`
- New: `agent-core-env` has zero dependents until step 2 below, so it's zero-risk to land first.
- `agent-generator-plugin` (template only — not imported code, so it doesn't appear as an `nx affected` build dependent, but its own generator test, once added, should run).

Use `npx nx affected -t test` (never targeted `nx test <project>`) once any of the 5 packages is touched — per `AGENTS.md` §5 / `DEBT-PROCESS-AFFECTED-TEST-001`, targeted testing on a package with dependents is a known blind spot in this repo.

**Live-coordination hazard:** `BACKLOG.md`'s own `ENV-ADOPT-CLUSTERS(1)` entry already calls this cluster "**highest value, live coordination hazard**"[28] — multiple packages must agree on one physical file's schema at all times. The safe order below is designed to never leave the family in a state where some packages have moved to the new resolver and others haven't while a server is running against them.

**Recommended order:**
1. **Fix `BUG-AGENTMCP-DOCLINK-001`** (trivial, already filed, fully decoupled) — do it whenever, no ordering dependency.
2. **Scaffold + implement + test `agent-core-env` in isolation.** Zero dependents yet, so `npx nx build agent-core-env && npx nx test agent-core-env` is the entire verification surface. Land this alone first.
3. **Retarget `drizzle.config.ts` (2 files)** to `resolveRegistryDbPath()`. These are dev-tooling-only (`drizzle-kit generate`/`migrate`, invoked manually, never at server runtime) — lowest risk of the source edits, and proves the new resolver works synchronously outside a test harness before touching anything the server depends on.
4. **Edit the 5 packages' `db/client.ts` + `db/migrate.ts` + `index.ts` together, in one coordinated change** (not package-by-package) — because `agent-engine-compiler` re-exports types/values sourced from the other 4 (`compile.ts` imports `AgentStore`/`CompositionStore` from `agent-store-prompts`, etc.), a half-migrated state where some siblings still export `{db,sqlite}` and others don't is more confusing to review, not less, and `nx affected -t test` will exercise the whole graph regardless of whether you land it as 1 commit or 5. Run `npx nx affected -t build,test,lint` afterward and confirm 0 failures before proceeding.
5. **Update the generator templates.** No live blast radius (nothing currently imports the generated output — it only affects packages scaffolded *after* this lands), but do it in the same session so the fix doesn't rot before the next registry package is generated.
6. **Wire `entrypoint/agent-mcp`** (`config.ts` field default + `buildPromptResolver()` delegating to the new resolver). This is the last step because it's the one place a real running server is affected — verify with the project's own live-testing requirement (`AGENTS.md` §7: a real MCP host call against the built server, not a bypass) before calling this done.
7. **Docs pass** (`REGISTRY-PACKAGE-RULES.md`, family `CLAUDE.md`s) — last, once the code is settled, so the docs describe what actually shipped.

**What could break mid-flight:** nothing server-facing, because of Finding B (Decision 3) — no live path reads the singletons today, so removing them cannot regress a currently-working read. The only way to introduce a regression is if some *other*, not-yet-discovered consumer of the bare exports exists that this review's grep missed; the negative-control import-side-effect test specified in Decision 5 is the safety net for exactly that case, and should be written and run against `main` *before* deleting anything, to prove it currently fails-red-for-the-right-reason (i.e., confirm today's import *does* create the file) before it's expected to go green post-fix.

---

## Open human decisions (do not proceed on these without explicit sign-off)

1. **Registry data migration.** Existing populated files (`./data/registry.db` at repo root, `~/.adhd/agent-core-provider/agents.db`, the project-scope `.adhd/agent-mcp/production/data/registry.db`) must be reconciled into whatever the new canonical location is — this design deliberately does not auto-migrate. Needs an owner and an explicit "here is the one true registry.db going forward" decision, verified by row counts.
2. **Agent-mcp's own operational data (the 48 agents).** This is a *different* database than the registry (Decision 4) — `~/.adhd/agent-mcp/agents.db` (flat, 48 rows, agent-mcp's own operational schema with a bare `composed_prompts` table that doesn't even match the current registry-family schema) vs the zero-config namespaced default (0 rows, at either `~/.adhd/agent-mcp/production/data/agents.db` or the project-scope path this repo's own `.mcp.json` currently points at). This belongs to agent-mcp's own environment adoption (`FEAT-ENV-ADOPT-001` Step 0, "unproven end-to-end"), not to this package's scope — flagging so it isn't dropped, and so nobody mistakes it for something `agent-core-env` will fix as a side effect.
3. **Default scope for the registry file** (`global` pin, as recommended in Decision 4, vs. letting it auto-detect project/global from cwd like agent-mcp's own operational store does). This is a behavior-affecting default for every consumer that doesn't set an explicit override.
4. **Cross-domain dependency precedent** (Decision 2) — `agent` domain depending on `environment` domain at the `packages/` library layer is a first for this repo. Not blocked by any written rule, but worth an explicit nod given there's no prior art at this layer to point to if it's ever questioned later.
5. **This repo's own `.mcp.json`** (uncommitted, in-progress, not touched by this review) currently forces `ADHD_ENV_SCOPE=project` + an explicit `ADHD_AGENT_REGISTRY_DB_PATH` pointing at the project-scope, currently-empty registry file. Once a canonical location is decided (item 1), whoever owns `.mcp.json` should revisit whether that override should still point there or at the new canonical path.

## Bugs discovered and filed during this review (already committed, `BACKLOG.md`)
- `DEBT-WORKSPACE-LINT-BOUNDARIES-001` — root `.eslintrc.json`'s `layer:`/`platform:` `depConstraints` are dead code for every package in the repo (Decision 2).
- `BUG-AGENTMCP-DOCLINK-001` — `agent-engine-compiler/CLAUDE.md` links to a nonexistent `../agent-nx/REGISTRY-PACKAGE-RULES.md` (Decision 5).

---

## Citations

`[main, architect-reviewer, claude, ENV-ADOPT-CLUSTERS(1) design gate]`

1. `.adhd/workspace.json` (groups, kinds.base, kinds.core descriptions)
2. `packages/environment/environment-base-spec/package.json`, `packages/dispatch/dispatch-base-spec/package.json`, `packages/apigen/apigen-base-{types,schema,errors,logical}/package.json` (dependencies fields, all empty of `@adhd/*`)
3. `packages/agent/agent-core-policy/package.json`, `packages/agent/agent-core-provider/package.json` (both depend on `@adhd/agent-base-types`)
4. `packages/agent/agent-store-prompts/project.json`, `agent-engine-compiler/project.json`, `agent-store-tools/project.json`, `agent-core-policy/project.json`, `agent-core-provider/project.json` (all `tags: ["layer:ai","platform:node"]`)
5. `packages/environment/environment-core-node/project.json` (tags), `package.json` (`name: "@adhd/environment"`)
6. `.eslintrc.json:20-99` (repo root, `depConstraints` for `layer:shared`, `layer:ai`)
7. `packages/agent/agent-store-prompts/package.json` (`version: "2.1.2"`, `publishConfig`)
8. `packages/workspace/workspace-codegen-nx/src/generators/core/schema.json`
9. Full-repo scan: `python3` script over `packages/*/*/package.json` dependencies/peerDependencies for any `@adhd/*` whose bare-name domain prefix differs from the owning package's directory domain — zero matches
10. `entrypoint/agent-mcp/src/config.ts:24` (`import { Environment } from "@adhd/environment";`)
11. `packages/agent/agent-store-prompts/src/store/*.ts`, `agent-store-tools/src/store/*.ts`, `agent-core-policy/src/store/*.ts`, `agent-core-provider/src/store/*.ts` (constructor grep, no `db/client` imports in any store file)
12. Repo-wide grep for `import.*{.*\bdb\b.*}.*from '@adhd/agent-` — matches only `__tests__` and `docs/plan/agent-final/superseded/agent-registry/demo/ingest-and-run.ts`
13. `.gitignore:51-56`; live `find` of repo-root `./data/` showing `registry.db{,-wal,-shm}`, `agents.db{,-wal,-shm}`, `agent-mcp/agents-{dev,published}.db{,-wal,-shm}`
14. `ls -la ~/.adhd/agent-core-provider/agents.db` — file exists
15. `sqlite3` queries against `~/.adhd/agent-mcp/agents.db` (`.tables`, `SELECT count(*) FROM agents` → 48) and `/Users/nix/dev/node/adhd/.adhd/agent-mcp/production/data/{agents,registry}.db` (`.tables`, counts)
16. `.mcp.json` (repo root, uncommitted) — `agent-mcp` entry `env.ADHD_ENV_SCOPE`, `env.ADHD_AGENT_REGISTRY_DB_PATH`
17. `packages/environment/ARCHITECTURE.md:76,88` (`DirSpec.scope`, `EnvironmentOptions.scope`), §2.3-2.4 (scope resolution + directory roots)
18. `packages/agent/agent-store-prompts/src/db/client.ts:13-16`, `agent-engine-compiler/src/db/client.ts:16-19`, `agent-store-tools/src/db/client.ts:9`, `agent-core-policy/src/db/client.ts:9`, `agent-core-provider/src/db/client.ts:10`
19. `packages/environment/ARCHITECTURE.md:21-24` (§2.1 "Live in-memory resolve")
20. All 5 `db/client.ts` files, `sqlite.pragma('journal_mode = WAL')` / `sqlite.pragma('foreign_keys = ON')` lines
21. `packages/agent/agent-store-prompts/drizzle.config.ts`, `packages/agent/agent-engine-compiler/drizzle.config.ts`
22. `packages/agent/agent-core-provider/src/seed/index.ts`, `agent-store-tools/src/seed/index.ts`, `agent-core-policy/src/seed/index.ts`, `agent-store-prompts/src/seed/index.ts` (all `seed(db)` with explicit param, no `client.js` import); zero call sites of `seed(` found anywhere else in the repo
23. `packages/agent/agent-generator-plugin/src/generators/registry-package/__files__/src/db/client.ts__tmpl__`
24. `packages/agent/agent-generator-plugin/src/generators/registry-package/__files__/src/index.ts__tmpl__`
25. `find packages/agent/agent-generator-plugin/src/generators/registry-package -maxdepth 1 -type f` — no `*.spec.ts`/`*.test.ts`
26. Repo-wide grep for `@adhd/agent-store-prompts` importers (excluding `dist/`)
27. `packages/agent/agent-engine-orchestrator/package.json` (`peerDependencies: {"@adhd/agent-engine-compiler": "^2.1.0"}`)
28. `BACKLOG.md` (`ENV-ADOPT-CLUSTERS (§2c)` entry, "highest value, **live coordination hazard**")
29. `entrypoint/agent-mcp/src/index.ts:83-140` (`buildPromptResolver`), `packages/agent/agent-engine-compiler/src/compile.ts:66,68,106,175-176` (`compileAgent`)
30. `packages/agent/agent-store-prompts/src/db/migrate.ts:1,12`; grep for `runMigrations()` (no `On` suffix) call sites repo-wide — only `entrypoint/agent-mcp/src/index.ts:212`, resolving to `entrypoint/agent-mcp/src/db/migrate.ts`, not any family package
31. `entrypoint/agent-mcp/src/config.ts:110-124` (`server.registryDbPath` field, hardcoded flat default) vs `:60-64,84-89` (`db.path` field, `env.files.db`-derived)
