// Regression fixture for BUG-APIGEN-029.
//
// Two shapes, matching the two real symptoms recorded in the BACKLOG entry
// against `~/dev/ai/sox-ecosystem/libs/memory-core`:
//
//   1. `SelfRefParams` — a plain LOCAL interface containing an optional
//      reference to itself. Mirrors the real `WriteParams` repro:
//      `"can't resolve reference #/definitions/WriteParams from id #"`.
//      Deterministically forces `ts-json-schema-generator` to hoist a
//      `definitions` entry with an internal `$ref` even though Path 1 runs
//      with `topRef: false` (BUG-APIGEN-026's fix, which only inlines the
//      ENTRY type itself — not a type it recursively/self-referentially
//      contains, which MUST stay a `$ref` since JSON Schema cannot inline a
//      cycle) — see `hoistNestedDefs`'s doc comment (extract.ts) for the full
//      traced mechanism (a type-text string mismatch between the top-level
//      param and the same type reached again via its own property defeats
//      the ancestors/deadlock guard, letting the generator resolve the same
//      type a second time and produce a self-contained `$ref`+`definitions`
//      pair nested inside the outer fragment).
//   2. `BetterSqlite3.Database` — a complex EXTERNAL interface. Mirrors the
//      real `db: BetterSqlite3.Database` repro: `"can't resolve reference
//      #/definitions/BetterSqlite3.Database from id #"`. In THIS no-tsconfig
//      test environment `Database` happens to resolve to a small flat schema
//      with no internal `$ref` at all (`ts-json-schema-generator`'s
//      `functions:"comment"` default strips every one of `Database`'s
//      chainable methods, so no cycle manifests here) — kept anyway as a
//      real complex-external-type regression per BUG-APIGEN-029's task
//      instructions, exercising the actual reported symptom (the route
//      dispatches successfully end-to-end) even though it doesn't trigger
//      the SAME internal mechanism `SelfRefParams` does in this environment.
//
// Kept in its own small fixture (not scalar-types.ts) — better-sqlite3's full
// .d.ts graph is larger than decimal.js's; decimal-nested.ts's note about
// per-export program-build cost multiplying across a shared fixture applies
// here too.
import BetterSqlite3 from 'better-sqlite3';

export interface SelfRefParams {
  key: string;
  override?: SelfRefParams;
}

export async function writeWithSelfRef(
  params: SelfRefParams
): Promise<string> {
  return params.key;
}

export async function queryDatabase(
  db: BetterSqlite3.Database,
  sql: string
): Promise<Array<{ id: number }>> {
  return db.prepare(sql).all() as Array<{ id: number }>;
}
