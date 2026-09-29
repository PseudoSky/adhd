---
name: "Partial-index correctness, integrity_check, and REINDEX"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "sqlite", "partial-index", "integrity-check", "reindex", "corruption", "expression-index"]
summary: "A partial index indexes only rows where its WHERE is true, so fewer entries than rows is by design. A desync is corruption: SQLITE_CORRUPT_INDEX (779) and PRAGMA integrity_check detect missing index entries; REINDEX (or DROP+CREATE) repairs them, and integrity_check(TABLE) verifies. quick_check skips the index-vs-table check. Stale expression indexes can look corrupt after version changes."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# Partial-index correctness, integrity_check, and REINDEX

**Failure class addressed:** live indexes desync (`ix_edge_dst_live`, `ix_node_kind_live` — partial indexes on live rows).

## Mechanism (authoritative)

- Partial index *(sqlite.org/partialindex.html)*: only rows for which the trailing `WHERE` expression evaluates to **TRUE** are indexed; rows where it evaluates to NULL or false are omitted. The `WHERE` clause may **not** contain subqueries, references to other tables, non-deterministic functions, or bound parameters. Supported since SQLite 3.8.0; a database file containing partial indexes is unreadable by versions prior to 3.8.0.
- A partial index legitimately having **fewer entries than table rows is by design**, not corruption. `PRAGMA index_list` reports `"1"` in its last column when an index is partial.
- SQLite maintains indexes — including partial and expression indexes — **transactionally** with the table. A partial-index desync is a corruption symptom, not a normal state.
- `SQLITE_CORRUPT_INDEX` (779) *(sqlite.org/rescode.html#corrupt_index)*: "SQLite detected an entry is or was missing from an index. This is a special case of SQLITE_CORRUPT … suggests that the problem might be resolved by running the REINDEX command, assuming no other problems exist elsewhere in the database file."
- `PRAGMA integrity_check` *(pragma.html#integrity_check)* looks for: table/index entries out of sequence, misformatted records, missing pages, **missing or surplus index entries**, UNIQUE/CHECK/NOT NULL errors, freelist integrity, and sections used more than once or not at all. It returns `ok` or one row per problem. `integrity_check(TABLENAME)` is a **partial** check (does not detect freelist/overlap issues). `quick_check` does **not** verify that index content matches table content.
- howtocorrupt.html §8.2: a **stale expression index** can appear corrupt after moving a database across platforms or changing SQLite versions, because a supposedly deterministic function changed output; it is cleared by `REINDEX`.
- **Turso-specific:** `integrity_check` ✅, `quick_check` ✅, `REINDEX` ✅ are supported. *(Turso COMPAT.md)*

## Correct pattern

- Detect desync with `PRAGMA integrity_check` (optionally scoped to one table); repair with `REINDEX <index>` or `DROP INDEX` + `CREATE INDEX`; re-verify with `integrity_check(TABLENAME)`.
- Keep partial-index predicates deterministic and self-contained — a simple expression on the indexed columns, e.g. `WHERE t_invalid IS NULL`.
- After a migration or on open, assert that the expected indexes actually registered (`PRAGMA index_list`) rather than trusting a silent open.

## Anti-pattern

- Comparing table row count to index entry count as a corruption test — this false-positives on **every** partial index.
- Using `quick_check` as a substitute for index-vs-table validation.
- Putting non-deterministic predicates (or functions whose output can change across versions) in a partial or expression index.

## References

- https://www.sqlite.org/partialindex.html
- https://www.sqlite.org/pragma.html#pragma_integrity_check
- https://www.sqlite.org/rescode.html#corrupt_index
- https://www.sqlite.org/howtocorrupt.html §8.2
