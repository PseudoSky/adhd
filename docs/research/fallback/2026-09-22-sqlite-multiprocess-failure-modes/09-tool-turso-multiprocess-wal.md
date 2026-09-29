---
name: "Turso Database multiprocess_wal (.tshm) — agent:blocked for production checkpoint-on-close"
topic: "tool-catalog"
tags: ["agent:blocked", "turso", "libsql", "multiprocess-wal", "tshm", "sqlite", "experimental", "multiprocess"]
summary: "Turso Database's experimental multiprocess_wal lets several OS processes share one .db via a .tshm shared-memory coordinator (single-writer + single-checkpointer slots, bounded reader slots, shared frame index; OFD/fcntl locks). 64-bit Unix + local FS + WAL only; mode-mixing rejected; not under MVCC; format versioned. Blocked for a production multi-process store of record because the feature is explicitly experimental, has macOS exclusive-locking reports, and a stale/frozen .tshm has produced 5/5 open failures. The correct multi-process answer remains WAL + synchronous=FULL + BEGIN IMMEDIATE, with owner election if write coordination must be explicit."
importance: 7
data_quality: verified
type: tool
decision: blocked
---

# Turso Database `multiprocess_wal` (`.tshm` sidecar)

**Decision: `agent:blocked`** for a production multi-process store of record. It is a legitimate future off-ramp, not a safe default today.

## What it is

Turso Database (the Rust re-implementation of SQLite, package `@tursodatabase/database`) exposes an **experimental** `multiprocess_wal` feature that lets several independent OS processes open and coordinate on one `.db` file through a third sibling file, `.tshm` (Turso shared memory).

## Mechanism

- `.tshm` is an mmapped coordinator tracking WAL state, a **single-writer** slot, a **single-checkpointer** slot, a bounded set of **reader slots** (each pinning a WAL frame), and a shared page-to-frame index. Cross-process byte-range locks are OFD locks on Linux and `fcntl` on macOS. *(docs.turso.tech/sql-reference/multiprocess-access)*
- Concurrency: writers are **serialized** across processes (not parallel); readers never block writers; checkpointing is serialized; snapshots are stable.
- Requirements: 64-bit Unix (Linux/macOS/Android); local filesystem with POSIX byte-range locks + mmap (NFS/CIFS/CephFS/GFS2/Lustre/OCFS2/AFS rejected → `InvalidArgument`); WAL mode; not in-memory. Windows/WASM/32-bit silently ignore the flag.
- Mode-mixing is rejected: opening without the flag while another process holds a live `.tshm` authority fails with "Database is already open with experimental multiprocess WAL in another process"; the reverse also fails. Read-only opens fall back to the legacy read-only WAL path.
- Not compatible with MVCC (`BEGIN CONCURRENT`). The `.tshm` format is versioned; a format bump invalidates existing files.
- Writers still serialize, so **`BEGIN IMMEDIATE` + retry is still required** — the feature does not remove write contention.

## Why blocked

- Explicitly **experimental**: "The on-disk coordination format and the public API may change between releases. Do not rely on the format for long-term storage across Turso versions."
- A **stale/frozen `.tshm`** (0-byte `-wal` + `.tshm` whose mtime froze at creation) produced **5/5 fresh-open failures** in production; the docs' claim that the `.tshm` is rebuilt from the WAL does not hold in that state.
- Reports of macOS exclusive-locking behaviour that can prevent multi-process access.
- Turso COMPAT.md itself: "We don't support mixed SQLite and Turso in multi-process scenarios."

## Correct alternative today

- Plain SQLite/libSQL **WAL + `synchronous=FULL`**, one `busy_timeout`, `BEGIN IMMEDIATE` for read-modify-write.
- If explicit write coordination across independent processes is needed, use an **owner-elected** model (a surviving owner process / broker) rather than engine-coordinated direct-open.

## Quality signals (verified)

- weekly_downloads: 49568
- version: 0.7.2
- license: MIT
- github_url: https://github.com/tursodatabase/turso
- docs_url: https://docs.turso.tech/sql-reference/multiprocess-access

## metrics_source

- weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@tursodatabase/database"
- version: "npm view @tursodatabase/database version"
- license: "npm view @tursodatabase/database license"
- repository: "npm view @tursodatabase/database repository"

## References

- https://docs.turso.tech/sql-reference/multiprocess-access
- https://docs.turso.tech/sql-reference/experimental-features
- Turso COMPAT.md (Guarantees; journaling modes)
