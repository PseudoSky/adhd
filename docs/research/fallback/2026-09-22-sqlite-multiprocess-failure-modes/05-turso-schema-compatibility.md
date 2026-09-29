---
name: "Turso/libSQL schema incompatibility and portable-schema strategy"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "turso", "libsql", "sqlite-compat", "schema", "fts", "vector", "custom-types", "portability"]
summary: "Turso and stock SQLite do not mutually parse each other's extended schemas. Turso-specific: CREATE INDEX ... USING (fts/custom), CREATE TYPE/DOMAIN, vector32/vector_distance_* (F32_BLOB), Tantivy FTS instead of FTS3/4/5 (which Turso rejects). libSQL adds RANDOM ROWID, ALTER TABLE ALTER COLUMN, CREATE FUNCTION ... LANGUAGE wasm. Keep the schema of record portable; probe capabilities; assert objects registered on open."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# Turso/libSQL schema incompatibility and portable-schema strategy

**Failure class addressed:** a classic SQLite engine cannot parse a schema created by Turso (and vice versa).

## Mechanism (authoritative)

- Turso COMPAT.md **Guarantees**: (1) "You should always be able to go back to SQLite if you want to." (3) "You need to opt in to any incompatible Turso feature, but even then we provide a migration path back to SQLite when possible." (4) **"We don't support mixed SQLite and Turso in multi-process scenarios."** Turso tracks SQLite version 3.50.4.
- Turso-specific / opt-in **schema** features:
  - `CREATE INDEX … USING <method>` (`index_method` experimental) — e.g. `USING fts` (Tantivy), custom index types.
  - `CREATE VIRTUAL TABLE … USING csv(...)`.
  - `custom_types` experimental — `CREATE TYPE`, `CREATE DOMAIN` for STRICT tables.
  - Vector: `vector`, `vector32`, `vector64`, `vector_extract`, `vector_distance_cos`, `vector_distance_l2`, `vector_concat`, `vector_slice` — "compatible with libSQL native vector search". (The column type token `F32_BLOB` is the libSQL vector column type; the function set is verified in COMPAT.md, the `F32_BLOB` token itself is MEDIUM confidence.)
  - **SQLite FTS3/FTS4/FTS5 are ❌ No** — Turso implements FTS via Tantivy and `CREATE INDEX … USING fts`.
- libSQL extensions *(libsql-sqlite3/doc/libsql_extensions.md)*: `CREATE TABLE … RANDOM ROWID`; `ALTER TABLE … ALTER COLUMN col TO <new definition>`; `CREATE FUNCTION … LANGUAGE wasm` backed by an internal `libsql_wasm_func_table`; custom WAL via `libsql_open(..., zWal)`. These are DDL that stock SQLite cannot parse.
- Consequence, both directions: a database whose `sqlite_master` contains a stock-SQLite-constructed FTS5 virtual table (and its shadow triggers) cannot be parsed by Turso's catalog build; conversely a Turso schema using `USING` / custom types / `RANDOM ROWID` is not parseable by stock SQLite.
- **Prior incident:** Turso's catalog build parses `sqlite_master` in rowid order and **aborts silently at the first unparseable row** (e.g. an fts5 residue row when no fts5 module exists). Every object after that row — tables, indexes, `_adapter_meta`, `_sox_engine` — never registers, with **no open-time error**. `PRAGMA table_list` showed only a subset; `no such table: edge`. *(sox-ecosystem memory 01KZSV4NMH7VTV2D55KPBRBK74; filed BL-506/507/508)*

## Correct pattern

- Keep the **schema of record portable**: standard SQLite types and standard `CREATE TABLE`/`CREATE INDEX` only.
- Gate any Turso-only feature behind a runtime capability probe and keep a portable fallback; document which extensions are used and provide the opt-out migration path Turso guarantees.
- On open, **assert the expected objects registered** (`PRAGMA table_list`, `PRAGMA index_list`) rather than trusting a silent open.
- If full-text search is needed, pick **one** engine (SQLite FTS5 *or* Turso Tantivy `USING fts`) and never create both in one file.

## Anti-pattern

- Assuming a Turso-created database is openable by stock SQLite (or vice versa).
- Mixing FTS engines / leaving fts5 shadow tables in a Turso-managed file.
- Shipping `USING`, custom types, or `RANDOM ROWID` without a documented migration path.

## References

- Turso COMPAT.md (Guarantees; Vector; Full-Text Search; Statements; PRAGMA tables)
- https://docs.turso.tech/sql-reference/experimental-features
- https://docs.turso.tech/sql-reference/statements/create-index (USING clause)
- libsql-sqlite3/doc/libsql_extensions.md
