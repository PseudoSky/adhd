# Code Review — agent-tool-registry (states scaffold-package … seed-and-roundtrip)

**Reviewer:** code-reviewer (opus) · **Gate:** code-review · **Diff base:** `34ed69a`
**Scope reviewed:** `packages/ai/agent-tool-registry/{src,drizzle,project.json,package.json}`
**Method:** full diff read of every source/test/migration file + raw test run (exit 0, 57/57).

This gate exists to catch design-intent violations the structural `audit_*.py`
oracle cannot — composite PKs implemented as non-unique `index()`, FKs that do
not match the decided topology, cross-package FK leaks, `tool_types` degrading
into a SQL enum, and tests that do not genuinely reopen / lack teeth.

---

## What was verified (with evidence)

### Design-intent fidelity — the core of this gate

- **Composite PKs are real `primaryKey()`, NOT non-unique `index()`.**
  - `tool_platform_bindings` PK `(tool_name, platform_id)`: `schema.ts:99`
    `primaryKey({ columns: [table.toolName, table.platformId] })` → migration
    `0001_gray_talkback.sql` `PRIMARY KEY(\`tool_name\`, \`platform_id\`)` →
    snapshot `0001`/`0003` `compositePrimaryKeys`. The `index("idx_bindings_platform")`
    at `schema.ts:100` is a *secondary* lookup index on `platform_id`, not a
    substitute for the PK.
  - `agent_tools` PK `(agent_slug, tool_name)`: `schema.ts:164` `primaryKey({columns})`
    → `0003_foamy_otto_octavius.sql` `PRIMARY KEY(\`agent_slug\`, \`tool_name\`)` →
    `0003_snapshot.json:64` `compositePrimaryKeys`. `idx_agent_tools_agent_slug`
    (`schema.ts:165`) is `isUnique:false` and exists only as a lookup index.

- **FKs match the decided within-package topology; no cross-package FK.**
  - `tools.type → tool_types.slug` (`schema.ts:33-35`, migration `0000`).
  - `tool_platform_bindings.tool_name → tools.name` + `.platform_id → platforms.id`
    (`schema.ts:84-89`, migration `0001` two FOREIGN KEY clauses).
  - `agent_tools.tool_name → tools.name` and ONLY that — `0003_snapshot.json:49-62`
    shows exactly one FK (`agent_tools_tool_name_tools_name_fk`); `agent_slug`
    has `"primaryKey": false` and no FK entry (`0003_snapshot.json:10-16`). This
    satisfies `[inv:no-cross-pkg-fk]`: `agent_slug` is a logical key.
  - `mcp_servers.provided_tool_ids` is a JSON text column with `"foreignKeys": {}`
    (`0003_snapshot.json:100-118`) — logical refs, no FK on a JSON column.

- **`[inv:lookup-not-enum]` holds.** `tool_types` is `sqliteTable("tool_types", { slug: text().primaryKey(), ... })`
  (`schema.ts:17-20`). `grep -n "enum"` across `src/` returns ONLY comments
  asserting "never an enum" — zero `enum()` calls. `header_format`, `transport`,
  `availability`, `permission` are all plain `text()` columns
  (`schema.ts:69, 93, 120, 157`).

- **`[inv:version-retained]`** — `tools.version` is `integer().notNull().default(1)`
  (`schema.ts:37`); seeder inserts with `onConflictDoNothing` (`seed/index.ts:68`)
  so a re-run never bumps or deletes a row. (Forward-looking; see non-blocking note 1.)

### CLAUDE.md compliance

- **Platform isolation `[inv:platform-node]`** — `project.json:14` tags
  `["layer:ai", "platform:node"]`. `grep` for `react|window|document|.css` in
  `src/` returns only doc comments; runtime imports are `node:fs`, `node:path`,
  `node:os`, `node:url`, `better-sqlite3`, `drizzle-orm` only. Pure Node + SQLite.
- **No relative cross-package imports** — `grep` for `../../` import specifiers
  returns nothing; all intra-package imports are `./`/`../` single-hop with `.js`
  ESM extensions; barrel `index.ts` is the single public surface.
- **JSDoc on shared public functions / I-prefix** — every store class, public
  method, and exported type carries JSDoc. (I-prefix: see non-blocking note 2.)

### Verification standard ("Proving features actually work")

- **Real components, not mocks** — all 5 test files open a real on-disk
  better-sqlite3 file under `os.tmpdir()`, apply real drizzle migrations via
  `runMigrationsOn`, and drive the real store classes. The only thing not present
  is an external boundary to mock — correct.
- **Reopen proves persistence `[inv:reopen-proves-persistence]`** — every store
  has an explicit close+reopen test:
  `tool-store.test.ts:246`, `mcp-server-store.test.ts:216`,
  `agent-tool-store.test.ts:199`, `binding-store.test.ts:295/426`,
  `roundtrip.test.ts:82`. Each closes `sqlite1`, opens a *new* connection to the
  same path, and asserts the read-back row (incl. JSON arrays/objects surviving
  `mode:'json'`).
- **Assertions with teeth / negative controls** —
  - `binding-store.test.ts:346` `[dod.1] negative-control` asserts the two
    platform aliases for the same tool differ AND each equals its expected value
    — would fail if `resolve()` ignored `platformId`.
  - `roundtrip.test.ts:170` `[seed-and-roundtrip.3]` corrupts the persisted
    alias via raw SQL, proves `resolve()` returns `WRONG_ALIAS` (test would go
    red on corrupt seed data), then restores and re-proves — a genuine teeth proof.
  - `agent-tool-store.test.ts:199` asserts the persisted permission is exactly
    `read_only` and `not.toBe("full")` — catches a hardcoded-default regression
    the store comment at `agent-tool-store.ts:71-72` explicitly warns against.
  - `agent-tool-store.test.ts:294` enables `foreign_keys = ON` then grants to a
    nonexistent `agent_slug` and asserts no throw — a behavioral proof of
    `[inv:no-cross-pkg-fk]` (a real FK would raise `SQLITE_CONSTRAINT_FOREIGNKEY`).
- **Deterministic without timing** — no `sleep`/wall-clock anywhere; persistence
  proven by reopen, concurrency not in scope.
- **Trust exit codes** — ran `nx test agent-tool-registry --skip-nx-cache`
  capturing `$?` directly: `REAL_EXIT=0`, 57/57 tests passed across 5 files.
- **Migration FK-safety** — `migrate-runner.ts:32-51` correctly disables
  `foreign_keys` on the connection *before* `migrate()` (outside any txn, since
  SQLite ignores the pragma inside the migrator's per-file transaction) and
  restores it after. The rationale is documented and correct.

### Seed completeness (cross-checked against SEED_DATA references in tests)

- 8 tool types (`seed/tool-types.ts`, asserted `roundtrip.test.ts:229`).
- 6 platforms (`seed/platforms.ts`, asserted `roundtrip.test.ts:208`).
- 15 canonical tools (`seed/tools.ts`, asserted `roundtrip.test.ts:139-156`
  against `TOOL_SEEDS.length`).
- claude_code + claude_api bindings with `unavailable` rows for absent tools
  (`seed/bindings.ts`), PascalCase aliases asserted `roundtrip.test.ts:252-274`.

---

## Findings

### Blocking
None.

### Non-blocking
1. **`[inv:version-retained]` has no behavioral test (non-blocking).**
   `tool-store.test.ts` only asserts `version === 1` on create; there is no test
   that bumps a tool's version and proves the prior row is retained. This is
   acceptable for *this* plan because `ToolStore` exposes no version-bump method
   yet — the invariant is forward-looking and the schema (no `onDelete cascade`,
   integer `version` column) does not contradict it. Recommend a dedicated
   version-retention test land with whichever future state introduces the bump
   API. (Out of scope for the criteria of this gate; noted for the backlog.)
2. **Shared interfaces are not `I`-prefixed (non-blocking, consistent with repo).**
   CLAUDE.md §7 says "Prefix all Shared/Data interfaces with `I`", but these are
   `layer:ai` domain types (`Tool`, `Platform`, `McpServer`, `AgentToolGrant`)
   and the sibling `@adhd/agent-mcp` package follows the same un-prefixed
   convention (`[ref:store-class]` cites it as the pattern to mirror). The code
   correctly matches the surrounding ai-package idiom rather than the
   shared-package rule, so this is not a defect.

---

## Verdict rationale

Every invariant this gate is responsible for — `[inv:no-cross-pkg-fk]`,
`[inv:lookup-not-enum]`, real composite `primaryKey()` (not non-unique `index()`),
within-package FK topology, `[inv:reopen-proves-persistence]`, `[inv:real-db-tests]`,
platform isolation — is satisfied with file:line evidence and a green real-DB
test run (exit 0, 57/57). The negative-control tests have genuine teeth. No
unresolved blocking findings.

VERDICT: APPROVED
