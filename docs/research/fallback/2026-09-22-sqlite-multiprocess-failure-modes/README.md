# Fallback findings — multi-process SQLite/libSQL/Turso failure modes

**Written:** 2026-09-22
**Reason:** the memory server became unreachable during Phase 5. `memory_ping()` succeeded once at the start of the run (status `ok`, `store_ok: true`), but all subsequent `memory_write` and `memory_recall` calls — and a re-`ping` — returned `MCP error -32001: Request timed out`. Because the **re-ping itself timed out** (a ping-level failure, not a normal `{ok:false}` payload), the sanctioned local-fallback protocol applies. These findings are **NOT yet in memory** and will not be found by a future `memory_recall` until someone ingests them.

**Ingestion:** each file is YAML frontmatter + markdown body, matching the `memory_write` payload shape (`name`, `topic`, `tags`, `summary`, `importance`, plus body content). To file them, call `memory_write` with `project_path=/Users/nix/dev/node/adhd`, `topic=sqlite-multiprocess-patterns` (patterns) or `topic=tool-catalog` (tools), the frontmatter `tags`/`summary`/`importance`, and the file body as `content`.

## Files

| File | Finding | Tag class |
|---|---|---|
| 01-journal-mode-sidecar-lifecycle.md | journal_mode persistence + `-shm`/`-tshm` sidecar lifecycle | pattern:recommended |
| 02-synchronous-durability.md | synchronous modes + ACK-before-durable commit | pattern:recommended |
| 03-wal-unlink-checkpoint.md | WAL unlink/replace under live use + checkpoint lifecycle | pattern:recommended |
| 04-partial-index-integrity.md | partial-index correctness + integrity_check + REINDEX | pattern:recommended |
| 05-turso-schema-compatibility.md | Turso/libSQL schema incompatibility + portable schema | pattern:recommended |
| 06-safe-migration.md | safe migration (backup-first, ledger, verify, rollback) | pattern:recommended |
| 07-lease-advisory-lock-deadlock.md | lease/advisory-lock deadlock — transaction-as-lock | pattern:recommended |
| 08-busy-locked-retry.md | SQLITE_BUSY / SQLITE_LOCKED retry policy | pattern:recommended |
| 09-tool-turso-multiprocess-wal.md | Turso `multiprocess_wal` (`.tshm`) | agent:blocked |
| 10-tool-vacuum-into.md | VACUUM INTO backup primitive | agent:approved |

## Primary sources used

SQLite: `wal.html`, `pragma.html` (journal_mode, synchronous, busy_timeout, integrity_check, wal_checkpoint), `rescode.html`, `lang_transaction.html`, `partialindex.html`, `howtocorrupt.html`, `lang_vacuum.html`, `c3ref/wal_checkpoint_v2.html`, `c3ref/busy_timeout.html`, `vfs-shm.txt`, `wal-lock.md`.
Turso: `docs.turso.tech/sql-reference/multiprocess-access`, `.../experimental-features`, `.../statements/create-index`, `COMPAT.md`.
libSQL: `libsql-sqlite3/doc/libsql_extensions.md`, README.
