# Scenario: `export-sqlite-type-annotation`

**Tier:** simple (one-line change — but with a real TS gotcha). **Real change shipped in:** commit `6dc8fdf`.

---

## The coding task

`client.ts` keeps the raw connection module-private. Another module
(`migrate.ts`) now needs it, so **export `sqlite`**. The obvious
`export const sqlite = new Database(resolvedPath)` makes `nx build` fail with:

```
error TS4023: Exported variable 'sqlite' has or is using name
'BetterSqlite3.Database' from external module ".../@types/better-sqlite3/index"
but cannot be named.
```

Make it export cleanly.

Context (before):
```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const sqlite = new Database(resolvedPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, { schema });
```

## The (small) catch

When you `export` a `const` whose inferred type comes from an external module's
namespace, TypeScript (with declaration emit) needs the type to be *nameable* in
the output `.d.ts`. The fix is an **explicit type annotation** so the emitter
doesn't have to infer/name it.

## Raw correct solution (as shipped)

```ts
export const sqlite: Database.Database = new Database(resolvedPath);
```
(`Database` is the default import; its instance type is `Database.Database`.)

## Rubric (0–5; "pass" = exports it AND the build would succeed)

| # | Criterion | Weight |
|---|---|---|
| R1 | Adds `export` to `sqlite` | ★★ |
| R2 | Adds an **explicit type annotation** that resolves TS4023 (`Database.Database`, or an equivalent `import type`) | ★★★ |
| R3 | Correct type (not `any`, not a fabricated type name) | ★★ |
| R4 | Doesn't otherwise change connection setup (pragmas, path) | ★ |

**Watch-fors:** `export const sqlite = …` with no annotation (still TS4023) — R2 ✗;
`export const sqlite: any = …` (compiles but defeats typing) — R3 partial;
"re-export via a wrapper function" or other over-engineering — unnecessary.
Primary thing this probes: does the model know the TS4023 "cannot be named" rule
and reach for the one-line annotation, vs. flailing.
