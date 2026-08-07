# Code Review — `@adhd/agent-policy` (states `policy-design` … `seed-and-roundtrip`)

**Reviewer:** code-reviewer (opus) · **Gate:** `code-review` · **Diff base:** `34ed69a`
**Scope:** `packages/ai/agent-policy` (32 files, +4101) · diff-read review against
project `CLAUDE.md` + this plan's `decisions.md` / `_shared.md` invariants.

**Default posture is NEEDS-WORK.** The verdict below is APPROVED and is justified
finding-by-finding against the binding decisions and cross-cutting invariants.

---

## Method

Every file claimed below was read via the Read tool. The full test suite was run
and gated on EXIT CODE (not stdout). The `build` (ship) target was run. The
sibling `@adhd/agent-mcp` package and the source `SEED_DATA.md` §3/§4/§9 were read
to ground the fidelity and "pre-existing pattern" claims.

- `nx test agent-policy` → **EXIT 0**, 37 tests / 5 files pass
  (inheritance 5, agent-policy-store 9, enforcement-plugin 14, roundtrip 4,
  policy-template-store 5).
- `nx build agent-policy` → **EXIT 0** (the real publish/ship target; TS compiles).
- `nx typecheck agent-policy` → EXIT 1 (see NON-BLOCKING-1 — pre-existing
  repo-wide tsconfig pattern, identical on `agent-mcp`; does not affect build/test/ship).

---

## Design-intent fidelity (what the structural audit can't catch)

### Composite keys are REAL `primaryKey()`, not non-unique `index()` — PASS
- `schema.ts:81` `primaryKey({ columns: [table.categorySlug, table.policySlug] })`
- `schema.ts:110` `primaryKey({ columns: [table.agentSlug, table.categorySlug] })`
- `schema.ts:155` `primaryKey({ columns: [table.agentSlug, table.policySlug] })`
- Confirmed in the generated DDL: `drizzle/0001_pale_marvel_zombies.sql`
  (`PRIMARY KEY(agent_slug, policy_slug)`) and
  `drizzle/0002_category_policy_inheritance.sql` (both composite PKs present).
  The `index(...)` calls alongside each PK are *additional* read-path indexes, not
  the uniqueness mechanism — the uniqueness is the real composite PK.

### `policy_types` is a LOOKUP table, not a SQL enum — PASS `[inv:lookup-not-enum]`
- `schema.ts:15-18` `policy_policy_types` = `text("slug").primaryKey()` +
  `description`. No `enum()`. New types added by seeding a row
  (`seed/policy-types.ts:20-49`, 7 canonical rows matching `SEED_DATA.md` §3
  exactly, including `scope`).
- `policy_policy_templates.type` is a real **in-package** FK →
  `policy_policy_types.slug` (`schema.ts:37-39`; DDL
  `0000_sleepy_bullseye.sql` `FOREIGN KEY (type) REFERENCES policy_policy_types(slug)`).

### Inheritance topology matches the DECIDED LAZY model — PASS (Decision 1)
- No materialized per-agent fanout table; `policy_category_policies` (one row per
  category attach) + `policy_agent_categories` (membership) joined at query time by
  `AgentPolicyStore.resolveForAgent` (`agent-policy-store.ts:303-353`).
- Resolved inherited rows carry `inherited_from = catPolicy.categorySlug`
  (`agent-policy-store.ts:344`); direct-attach rows carry `inherited_from = null`
  (`agent-policy-store.ts:177`). Direct-attach precedence over the inherited copy
  is implemented (`agent-policy-store.ts:333-336`) and proven
  (`inheritance.test.ts:229-278`).
- The headline DoD case is proven with REOPEN persistence: attach mandatory policy
  to category → add a NEW agent to the category AFTER → CLOSE handle → REOPEN from
  the same path → `resolveForAgent` returns the inherited row with
  `inherited_from = "quality-security"`, `is_mandatory = true`
  (`inheritance.test.ts:149-221`). `[inv:reopen-proves-persistence]` honored.

### No cross-package SQLite FK — PASS (Decision 0, `[inv:no-cross-pkg-fk]`)
- `agent_slug`, `category_slug`, `inherited_from` are plain `text(...)` with NO
  `.references()` (`schema.ts:71,104,106,139,151`). Only in-package FKs
  (`policy_slug`/`type` → templates/types) use `.references()`.
- Proven behaviorally: with `PRAGMA foreign_keys = ON`, inserting a junction row
  whose `agent_slug` has no matching row anywhere SUCCEEDS
  (`agent-policy-store.test.ts:184-216`). The proof has teeth — FK enforcement is
  demonstrably ON (the in-package `policy_slug` FK requires the template to be
  seeded first; the negative-control roundtrip test asserts a UNIQUE PK violation
  does throw), yet the phantom agent_slug insert does not.

### `enforcement` is a JSON ARRAY, not a scalar/enum — PASS `[inv:enforcement-is-array]`
- `schema.ts:44` `text("enforcement", { mode: "json" })`. Multi-value case
  `no-credentials = ["agent","ci"]` round-trips through reopen
  (`roundtrip.test.ts:126-128`, asserts `Array.isArray` AND deep-equals).

### Enforcement plugin honors the agent-mcp-budget contract + Decision 2 — PASS
- Mirrors `[ref:budget-plugin]`: exports `configSchema` (zod), a `Plugin` class
  whose `install()` registers observational `register(...)` handlers wrapped in
  try/catch AND exactly one `hooks.registerEnforcement("pre:model_request", …)`
  with NO try/catch (`plugin/index.ts:60-105`); `createPlugin` exported as BOTH
  named and `default` (`plugin/index.ts:143-148`, `index.ts:42-46`).
- `EnforcementEvent` stays `"pre:model_request"`-only: verified in
  `agent-mcp-types/src/hooks.ts:46` (`type EnforcementEvent = "pre:model_request"`);
  the plugin registers nothing else (Decision 2). `sox-audit-trail` is seeded
  `hook_type:"observational"` with `enforcement:["hook"]`
  (`seed/policy-templates.ts:87-103`) and is documented as observational-only — no
  `registerEnforcement` for it, matching Decision 2. No `agent-mcp-types` amendment
  was made (DAG unchanged), per the forcing-function deferral.
- Drives the REAL `HookRegistry` from `@adhd/agent-mcp-types`, not a mock
  (`enforcement-plugin.test.ts:15,90-128`). `enforce()` propagates throws
  (`registry.ts:58-64` — handlers run un-try/caught). Throw-on-violation proven
  through `hooks.enforce("pre:model_request", …)` rejecting with
  `{isEnforcementError, code:"POLICY_VIOLATION"}` (`enforcement-plugin.test.ts:108-128`),
  with a NEGATIVE CONTROL proving a no-op handler does NOT reject — i.e. the throw
  is load-bearing (`enforcement-plugin.test.ts:278-316`). `[inv:enforcement-throws-propagate]`,
  `[inv:real-registry-not-mock]` honored.

### Override-merge semantics = shallow top-level merge — PASS (Decision 3)
- `resolveEffectiveRules` (`agent-policy-store.ts:381-389`) is exactly
  `{...templateRules, ...overrideConfig}`; empty/null override returns the template.
  Proven: override key replaces template key, arrays replaced wholesale
  (`disallow_tools` test), empty/null ⇒ template unchanged
  (`agent-policy-store.test.ts:320-349`).

### CLAUDE.md conformance — PASS
- `platform:node` + `layer:ai` tags (`project.json:14`); pure Node + SQLite, no
  browser imports anywhere in `src`. Imports use `@adhd/agent-mcp-types` workspace
  path (`plugin/index.ts:16`, `rate-policy.ts:9`), not relative cross-package paths.
- Public shared functions carry JSDoc (`resolveEffectiveRules`, `seed`, store
  methods, `evaluateRatePolicy`). Domain interfaces are exported & documented;
  `I`-prefix is applied to the cross-package contract types it consumes
  (`IHookRegistry`, `IEnforcementError`) consistent with `agent-mcp-types`.
- Verification standard met: real components (real on-disk SQLite, real
  `HookRegistry`), assertions with teeth (three negative controls:
  `enforcement-plugin.4` no-op handler, `policy-inheritance.3` no-join path,
  `seed-and-roundtrip.3` plain-INSERT UNIQUE violation), persistence proven by
  CLOSE+REOPEN, gated on EXIT CODE.

---

## Findings

(No blocking findings. Non-blocking observations recorded for the backlog.)

NON-BLOCKING-1 — `nx typecheck agent-policy` exits 1 with TS6306
("Referenced project tsconfig.lib.json / tsconfig.spec.json must have setting
composite: true"). This is a **pre-existing, repo-wide tsconfig pattern**, NOT
introduced by this plan: the root `packages/ai/agent-policy/tsconfig.json:13-22`
both `include`s `src/**/*.ts` AND `references` two project tsconfigs that lack
`composite: true` — and the sibling `packages/ai/agent-mcp/tsconfig.json` has the
identical shape and `nx typecheck agent-mcp` fails with the same TS6306. The
real ship path is unaffected: `nx build agent-policy` compiles cleanly (EXIT 0)
and `nx-release-publish` dependsOn `build`+`test`, both of which pass. Recommend a
workspace-wide BACKLOG item to add `composite: true` to the referenced
`tsconfig.lib.json`/`tsconfig.spec.json` (or drop `include` from the solution
tsconfig so the `typecheck` target stops conflating the two), tracked across all
`packages/ai/*` packages, not solved locally in this plan.

NON-BLOCKING-2 — `resolveEffectiveRules` returns the `templateRules` object **by
reference** when there is no override (`agent-policy-store.ts:385-386`). A caller
that mutates the returned object would mutate the cached template rules. Current
consumers treat it read-only and the array-replace/override path returns a fresh
spread object, so no bug exists today; a defensive `{...templateRules}` copy on the
no-override branch would harden it. Non-blocking.

---

VERDICT: APPROVED
