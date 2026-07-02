# @adhd/agent-compiler — agent registry package rules

This is a **golden-path agent registry package** scaffolded by `@adhd/agent-nx`.
The full, authoritative invariants live in
**[`../agent-nx/REGISTRY-PACKAGE-RULES.md`](../agent-nx/REGISTRY-PACKAGE-RULES.md)** —
read it before changing this package. The non-negotiables, in brief:

- **`platform:node`.** Never import browser code (`react`, `window`, `document`,
  CSS). Pure Node + SQLite.
- **One shared SQLite file.** Every registry-family package opens its own Drizzle
  instance against the SAME file. All of this package's tables are prefixed
  **`compiler_`**. NO `ATTACH DATABASE`. NO cross-package SQL foreign
  keys — cross-package keys are logical, resolved at compile time. Within-package
  FKs ARE real (`.references()`).
- **Controlled vocabularies are lookup tables / plain text, NEVER SQL enums.**
- **Composite PKs are real** `primaryKey({ columns: [...] })`, never a
  non-unique `index()`.
- **Store classes wrap Drizzle** and surface typed error codes.
- **Tests use a real on-disk SQLite file + real migrations.** Prove persistence
  by CLOSE + REOPEN. Assertions must have teeth (a negative control must go red).
  Gate on the runner's **EXIT CODE**, never on stdout `grep -q passed`
  (better-sqlite3 can segfault on vitest teardown).
- **Bump-don't-delete** for any version-retained table.

Targets (`build`/`test`/`typecheck`) inherit cache + `^build` from `nx.json`
`targetDefaults`. Do not redefine `cache`/`dependsOn` locally.
