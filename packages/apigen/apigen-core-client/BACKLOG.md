# BACKLOG — @adhd/apigen-core

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../../BACKLOG.md)
(§ _Extraction performance + memory-leak work (2026-07-02)_).

## Fixed

### PERF-APIGEN-001 — redundant TypeScript program builds — RESOLVED 2026-07-02

- `extract()` / `generateSchemas()` / `extractClasses()` each built a fresh ts-morph
  `Project` per call (~1–2s each; the orchestrator built ~2 per source per run) and the
  ts-json-schema-generator cache grew a new ~100–200MB entry on every file edit, forever.
- Fixed by `src/lib/extraction-session.ts`: a shared per-run `ExtractionSession`
  (optional `session` on `ExtractOptions` / `GenerateSchemasOptions` /
  `ExtractClassesOptions`; created+disposed internally when absent) plus a bounded
  persistent tier (LRU-capped generators via `APIGEN_PROGRAM_CACHE`, default 8, `0`
  disables; version-checked persistent Project + schema maps, refreshed on edit).
- Measured: cold 37.4s → 7.4s, warm → 6–11ms (6 files × 10 fns); core suite 64.6s → 8.4s.
- Guards: `src/test/extraction-session.spec.ts` (work counts; proven red under a
  negative control), `apigen-cli`'s `src/test/perf.spec.ts` (consumer outcome).

### Deliberate non-change: per-parameter `buildSchema` loops stay sequential

`buildSchema` is synchronous CPU work under an async signature — `Promise.all` gains
nothing and would race morph-walk's shared-SourceFile probe aliases. Do not "optimize"
these loops with concurrency.

## Open

### DEBT-APIGEN-CACHE-001 — persistent cache versions the ENTRY file only

A type imported from another file that changes (entry file untouched) is not detected —
same invalidation semantics the generator cache always had. Fix direction: include the
program's referenced-files set in the version stamp.

### DEFER-APIGEN-PERF-001 — worker_threads parallel extraction (stretch)

Per-source fan-out across workers for multi-source cold runs. Deferred: bundled-CLI
worker-entry complexity vs. modest gains now that warm runs are ~free.
