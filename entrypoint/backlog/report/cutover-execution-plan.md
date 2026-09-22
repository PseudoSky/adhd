# Cutover Execution Plan — restore a writable production backlog graph

> Source: architect plan, 2026-09-22. Persisted by the orchestrator so execution
> survives context compaction. **User approved full autonomous execution**
> (2026-09-22). Excluded from the grant: publishing `@adhd/backlog` to npm (D4)
> and merging PR #9 (D3) — both stay human-gated. Stop-and-report on any gate
> failure; never mutate the legacy store.

## 0. Verified facts this plan rests on

| Fact | Evidence |
|---|---|
| Global bin is a pnpm shim (`~/Library/pnpm/adhd-backlog`), flipped to local source by `pnpm link -g` and back to registry by `sync-global.mjs` | `PUBLISHING.md:147, 461-490` |
| Legacy production store is Turso-marked, closed `CHECK(kind …)` / `CHECK(rel …)`, so v2 writes (`kind='project'`, `rel='owns_project'`) are rejected | `tmp/write-debug/probe8.mjs` |
| `applySchema()` creates an OPEN schema for a fresh file (`INLINE_MIGRATION_DDL`) | `graph-store dist/index.js:226-271, 1098-1122` |
| Closed CHECK never healed: `nodeNeedsRebuild` has `&& !sql.includes("'generic'")` — a CHECK already listing `'generic'` evaluates false | `dist/index.js:1168`; `SPEC-PKT-58.md:110-120` |
| `migrateToOpenSchema()` refuses Turso stores (`UnsupportedBackendError`) | `open-schema-migration.ts:101-112,192-197` |
| ETL source of truth = read-only `corpus.jsonl`/`edges.jsonl` extract; imports raw `backlog-item` rows → target `issue` nodes | `tools/etl/corpus-loader.ts:1-7,49-51`; `tools/etl/tmp/extract-live-store.ts:52` |
| ETL previously verified 1788/1788 vs the 2026-09-19 snapshot (1534 live / 254 invalidated) | `tools/etl/tmp/PARITY-v2.md` |
| `~/.adhd/backlog/production/config.yaml` = `{migration.phase: phase-3, embedding.enabled: true}`, NO `db.path`; `migration.*` is stale cruft | read of that file; `src/env.ts:34-122` |
| Store resolution: `ADHD_BACKLOG_DATABASE_PATH` → config `db.path` → namespaced default | `src/env.ts:180-204` |
| `.mcp.json` points the backlog MCP server at repo-relative `entrypoint/backlog/dist/index.js` — split-brain vs the global bin | `.mcp.json:18-22` |
| Serve lock removed (A17) — nothing prevents multiple long-lived holders | `STATE.md` A17 |

**Two contradictions to resolve before acting:**
1. **Bug 4 vs source:** `src/index.ts:172-185` DOES call `initTelemetry` in the bin-entry branch — verify the actually-invoked dist before changing code (likely stale dist).
2. **Count drift:** debug (09-22) 3311 nodes / 1747 edges / ~1560 items vs PARITY (09-19) 3280/1731/1788 — something wrote after the snapshot. **Re-extract fresh; the existing cutover target may be stale.**

## A. Immediate mitigation — make filing work

Do NOT create an empty fresh store (strands 1788 items); do NOT rely on an env var (a global symlink cannot carry env). Correct interim: point the global bin at a **frozen build** and the store at the **promoted cutover target** via config.

```bash
git worktree add .worktrees/backlog-cutover 2118d384        # frozen known-good
cd .worktrees/backlog-cutover && corepack pnpm install
npx nx build backlog
cd entrypoint/backlog && pnpm link --global
readlink -f "$(which adhd-backlog)"; adhd-backlog --version
```

Store redirection (preferred: config, not env) — edit `~/.adhd/backlog/production/config.yaml`:
```yaml
db:
  path: /Users/nix/.adhd/backlog/production/data/backlog-v2.db   # promoted cutover target
embedding:
  enabled: true
```
Remove the stale `migration.phase` key. Success: real `create` returns ok + reads back; legacy mtime unchanged by the write; symlink resolves inside the frozen worktree.

## B. The cutover (run from the frozen worktree, never the live Wave-0 tree)

- **B1 — fresh read-only extract** against the current legacy store (online backup via the adapter, `mode=ro`). Promote `extract-live-store.ts` out of `tmp/` into a committed `tools/etl/` path. Gate: reconcile source counts against both PARITY (3280/1731/1788) and debug (3311/1747/~1560); unexplained delta = finding.
- **B2 — ETL into a NEW open-schema store.** If fresh `corpus/edges` JSONL hashes match the frozen corpus → reuse the embedded `cutover-target-v2.db`; else re-run `tools/etl/cli.ts` (expect `failed: []`) + the embed backfill. New store is open-schema by construction. Legacy never touched.
- **B3 — parity validation (all must pass, full population):** P1 population 1788/0 missing/0 spurious/0 mismatch; P2 liveness 1534/254; P3 status histogram exact; P4 citations full-population multiset; P5 projects (37) counts; P6 **CLI-visible parity** — `meta.total` equals the source count under the same predicate the `query` verb uses; P7 every mapped uid retrievable; P8 real create/claim/transition persist + read back. **The 675 delta must be decomposed into named buckets (invalidated / superseded / terminal-dismissed / missing-edge / residual); acceptance = residual 0.** If residual ≠ 0, fix the read path BEFORE the flip.
- **B4 — flip.** Set `db.path` in config.yaml (or rename-swap with a timestamped backup). Legacy survives as rollback.
- **B5 — post-flip smoke** (real binary, exit codes): query, get, projects view, similar view, create+get+claim+transition+get. Update STATE.md B3/B4/B5/C2/F3. Rollback: revert the config line / rename back.

## C. The live serve process (PID 46472 at diagnosis)

Enumerate ALL holders (`lsof`), never assume one. Stop gracefully (`kill -TERM`, bounded poll until ESRCH — no sleeps). If host-managed (`.mcp.json`), it may respawn post-flip — confirm it resolves the new store and uses the frozen build. Flip only after no holder remains; then restart serve and verify MCP tools answer against the new store. Archive stale `.serve.lock` + `.stale-*` debris.

## D. Seven adjacent bugs — owner, fix, sequence

| # | Bug | Owner | Fix | Sequence |
|---|---|---|---|---|
| 3 | Global symlink → unmerged worktree | in-repo wiring/ops | Point at frozen build (A); later `pnpm add -g` published version | A — first |
| 7 | Stale worktree install (graph-store 0.9.2 vs lock 0.10.0) | worktree node_modules | `corepack pnpm install`; verify versions; rebuild | A — before ETL |
| 4 | Telemetry dropped (BL-404) | in-repo | Verify resolved dist calls initTelemetry; likely stale dist (fix via 3/7) | A — tied to 3/7 |
| 6 | Turso driver panics on `PRAGMA auto_vacuum` | upstream tursodatabase | No in-repo caller exists; report upstream; document never-issue | now (report) |
| 1 | `nodeNeedsRebuild` never heals closed CHECK listing 'generic' | sox-ecosystem graph-store | Drop the `&& !sql.includes("'generic'")` guard (reconcile ADR-0010 D3 / BL-447 — surface as ADR question) | post-cutover; publish |
| 2 | `migrateToOpenSchema` refuses Turso | sox-ecosystem graph-store | Turso-native rebuild OR explicit non-goal (ETL is the supported route) | post-cutover |
| 5 | Sidecar churn `-shm` ↔ `-tshm` | sox-ecosystem store-adapter | Stop reconciling a live peer's sidecar; canonicalize | after version reconciliation; publish |

Bugs 1/2/5 are NOT cutover blockers (a fresh file sidesteps all three).

## E. Gates vs autonomy

**Autonomy covers:** sox-ecosystem edits + publish; in-repo fixes; ETL/parity/tests; filing; worktree reinstall; symlink repoint to frozen build; reporting bug 6 upstream; **the cutover + flip (user approved 2026-09-22)**.
**Human-gated:** D3 merge PR #9; D4 publish `@adhd/backlog` (sox grant does not cover it); ADR-0010 D3 decision shape (propose, don't decide).

## F. Wave 0 interaction (hard constraint)

`entrypoint/backlog/src` is being edited concurrently. Never build/link the global bin from the live Wave-0 worktree. Never re-run the ETL against a mid-edit tree. Do not depend on any Wave-0 edit. Re-verify `tools/etl` build/tests in the frozen worktree, not the live one.

## Closing verification checklist

1. `git status --porcelain` accounted for. 2. Legacy store byte-identical + preserved at a named backup. 3. P1–P8 green; 675-residual = 0. 4. Real global-bin AND real MCP create both succeed against the new store; legacy mtime unchanged. 5. `nx affected -t build test lint` green in the frozen worktree; STATE.md updated; CHANGELOG written. 6. Bugs 3/4/6/7 resolved or filed; 1/2/5 filed against sox-ecosystem with publish tracked.
