# D-B — Artifact lifecycle and ownership (substrate layer)

> **Plane:** substrate. Repos: **`sox-ecosystem`** (install-engine, host-runtime, apps/sox) and
> **`claude-agents`** (authoring gate, git-manager binding). Ticket `48d7dcea-121c-42f7-b906-f247ee69a799`.
> Consumes **SR-10, SR-11, SR-12, SR-16**. Scope is the **install/deploy layer only** — these are
> plain files; file-level atomicity is correct *here* and is explicitly **refused for backlog data**
> (adhd ADR-0001/0012; DESIGN.md §0).
>
> **Governing ADRs (sox):** ADR-0004 (`ownership.json` keyed `(extId, scope)`;
> `[inv:no-untracked-injection]`, `[inv:reversible-injection]`) and ADR-0003 (identity = `id +
> checksum`; `--frozen-lockfile` fails on drift) are **accepted and binding**. ADR-0012 (parallel-
> process write invariant; supersedes ADR-0007's single-writer claim) is **accepted and binding**.
> ADR-0014 (retention) is **PROPOSED / design-only** — treated as design input only, and its
> **D5 prerequisite** (no `--apply` before a proven restore path) constrains §5 for the memory-snapshot
> class. ADR-0013 (no env-var feature toggles) is accepted — every knob below is typed config.

## DoR

- **Owner repo:** **`sox-ecosystem`** (install-engine, host-runtime, apps/sox) + **`claude-agents`** (authoring gate, git-manager binding). · **Wave:** unstated (substrate pass-2 has no wave assignment — a gap). · **Dependencies:** none external. The git-manager sub-item is blocked by S1–S3 **within this ticket** and is explicitly out of the critical path. · **Evidence requirement:** AC1/AC2 use **two real OS processes** with a file-signal barrier and key on process exit codes (never stdout); drift/reconcile tests are hash-based and read-only. Two fixed-`.tmp` sites (`ownership.ts` **and** `install.ts`) must both be flipped — a partial flip leaves one temp racing.

## Summary
Replace the two fixed-temp-path publishes (`ownership.ts:132`, `install.ts:598`) with one shared
`atomicWrite` primitive: unique per-process temp (`O_EXCL`) on the same filesystem, fsync, then **one
atomic `rename`** — the rename is the correctness mechanism; an advisory lock may only bound duplicate
work and a concurrent non-cooperative writer must not corrupt the result (ADR-0012). The ownership
entry is written **after** the effect it records, never before; a malformed index is a **loud typed
error**, never `{owned: []}`. A new **read-only** drift pass recomputes **content hashes** (never
mtime/size) and emits `still-valid | drifted | gone | foreign` (+ an honest `unverifiable` for
pre-hash legacy rows); remediation is a separate act. A **roots-based** retention pass soft-deletes to
a trash namespace under a grace window and refuses to touch anything it has no roots model for. A
read-only reconciliation reports the `extensions.lock` ↔ installed-set difference in both directions.
A second-instance extraction gate guards generalizing a mechanism into an agent/skill.

## Grounding (read this session)
`libs/install-engine/src/ownership.ts` — `readOwnership` (silently returns an empty index on parse
error), `writeOwnershipAtomic` (fixed `.tmp`), `OwnershipIndex.save` (lost-update refusal),
`upsertOsUnitEntry` (strict+verify precedent), `supersededEntries`;
`libs/install-engine/src/install.ts` — `writeLockfileAtomic` (**fixed `.tmp`** — the second instance
of the same defect), `install`, the ownership-recorded-after-placement call site, the best-effort
lockfile sync (swallows), `recordOwnership` (best-effort);
`libs/install-engine/src/verify-integrity.ts` (`verifyIntegrity`, checksum authority);
`libs/install-engine/src/diff.ts` (`sha256`/`hashFile`, `DiffKind` `up-to-date|drifted|missing|
will-change` — no `gone|foreign`); `libs/install-engine/src/data-paths.ts` (`scopeConfigPaths`);
`apps/sox/src/main.ts` (`cmdInstall`, `cmdUninstall`, `hostPlaceExtension`);
`tools/snapshot-gc.mjs` (report-only, ADR-0014), `docs/decisions/0014-memory-snapshot-retention-policy.md`.
`claude-agents/install-agents.sh` (flat `.claude/agents` drop), `tools/skills/user-thinking/SKILL.md`
(`generalize` action), `tools/.claude-plugin/plugin.json`. git-manager exists:
`sox-ecosystem/extensions/agents/git-manager/`; `GIT-POLICY.md` is a documented target path only
(`git-manager.md`) with **no file on disk**. (All cited by symbol — a bare line number rots on every edit.)

## Ordering guarantees (invariants — each has a test)
1. **B-I1 — correctness is the rename, never the lock.** Publish = unique `O_EXCL` temp on the same
   fs + fsync + one `rename`. An advisory lock (if any) may bound duplicate work only; a concurrent
   **non-cooperative** writer cannot corrupt the result.
2. **B-I2 — effect, then marker.** The ownership entry is written only after the placement it records
   succeeded. Crash between effect and marker ⇒ artifact **untracked-and-repairable**; never
   **tracked-and-absent**.
3. **B-I3 — no silent empty index.** Any parse failure on `ownership.json`/`extensions.lock` raises a
   typed error. `{owned: []}`/`{resolved: {}}` is returned **only** when the file genuinely does not exist.
4. **B-I4 — hash-only verdicts.** The drift verdict is computed from recomputed **content hashes**;
   mtime/size are never a verdict input. (The `save()` external-change guard may keep a cheap change
   signal — its failure mode is a retry, not a wrong answer — see §3.)
5. **B-I5 — detect ≠ remediate.** The detect pass mutates nothing; repair is a separate invocation.
6. **B-I6 — bounded retention, roots-first.** No artifact with a live root (generation, lock entry,
   running process) is ever reclaimed. No roots model ⇒ never auto-cleaned. Deletion is soft (trash)
   until the grace window elapses.
7. **B-I7 — reconciliation is read-only.** It reports; it never repairs.
8. **B-I8 — no untracked injection.** Every placed file/key/store is recorded (ADR-0004 D6a); a failed
   ownership write is loud, not swallowed.

## Files
| Repo | Path | Change |
|---|---|---|
| sox-ecosystem | `libs/install-engine/src/atomic-write.ts` | create |
| sox-ecosystem | `libs/install-engine/src/ownership.ts` | modify |
| sox-ecosystem | `libs/install-engine/src/install.ts` | modify |
| sox-ecosystem | `libs/install-engine/src/drift.ts` | create |
| sox-ecosystem | `libs/install-engine/src/reconcile.ts` | create |
| sox-ecosystem | `libs/host-runtime/src/retention.ts` | create |
| sox-ecosystem | `apps/sox/src/main.ts` | modify |
| claude-agents | `tools/authoring/extraction-gate.mjs` | create |
| claude-agents | `tools/authoring/extraction-gate.spec.mjs` | create |
| claude-agents | `extensions/agents/git-manager/git-manager.md` | modify (blocked phase) |

## Interface / type changes

### New: `libs/install-engine/src/atomic-write.ts`
```ts
/** Publish `data` at `filePath` atomically: unique O_EXCL temp on the same fs, fsync, one rename. */
export function atomicWriteFileSync(filePath: string, data: string | Buffer): void;
// temp name: `${filePath}.${process.pid}.${atomicCounter++}.${randomBytes(6).toString('hex')}.tmp`
// open with flag 'wx' (O_EXCL) → write → fsync(fd) → close → renameSync(tmp, filePath) → fsync(dir)
// on any throw: best-effort unlink(tmp); never leaves a fixed-`.tmp` name.
export function withReconciledRetry<T>(filePath: string, fn: () => T, opts?: { attempts?: number }): T;
// re-load → merge → save loop; catches OwnershipConflictError and retries. Correctness stays
// in atomicWriteFileSync; this only resolves a *lost update* between two writers (AC1).
```

### `libs/install-engine/src/ownership.ts`
```ts
// BEFORE
export function readOwnership(filePath: string, opts: { strict?: boolean } = {}): OwnershipFile
//   non-strict: JSON/parse/shape failure → { version: 1, owned: [] }
export function writeOwnershipAtomic(filePath: string, data: OwnershipFile): void
//   const tmp = filePath + '.tmp'; writeFileSync(tmp, …); renameSync(tmp, filePath)

// AFTER
export function readOwnership(filePath: string, opts: { strict?: boolean } = {}): OwnershipFile
//   ENOENT → { version: 1, owned: [] }   // genuinely absent
//   any parse/shape failure → throw OwnershipCorruptError (B-I3) in BOTH modes;
//   `strict` is retained for signature compatibility but no longer yields an empty index.
export function writeOwnershipAtomic(filePath: string, data: OwnershipFile): void
//   → atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n')

export type OwnedEntry =
  | { kind: 'file-drop';   path: string; contentHash: string }   // contentHash: sha256:<hex>
  | { kind: 'materialize'; path: string; contentHash: string }   // NEW field on both
  | /* …unchanged: config-key, array-values, object-array-values, lockfile-key, registry-record, agent-catalog, os-unit… */;
```
`OwnershipIndex.save()` re-implemented as `withReconciledRetry(this.filePath, () => { re-stat guard;
writeOwnershipAtomic(...) })` so two concurrent installs of **different** extensions both persist
(AC1) without depending on a lock; the stat guard stays as a fast change signal only.

### New: `libs/install-engine/src/drift.ts`
```ts
export type DriftVerdict = 'still-valid' | 'drifted' | 'gone' | 'foreign' | 'unverifiable';
// 'unverifiable' is an honest fifth verdict: a *pre-existing* file-drop/materialize entry
// written before `contentHash` existed. It is NEVER reported 'still-valid' (SR-11 names four;
// this fifth exists only so a migration can be truthful rather than silently optimistic).
export interface DriftEntry { extId: string; scope: string; kind: OwnedEntry['kind'];
  target: string; verdict: DriftVerdict; expected: string | null; actual: string | null; }
export interface DriftReport { scope: string; entries: DriftEntry[];
  counts: Record<DriftVerdict, number>; }
/** READ-ONLY (B-I5). Compares recomputed content hashes only — never mtime/size (B-I4). */
export function detectDrift(scope: DataScope, root?: string): Promise<DriftReport>;
```
A managed-path scan flags a filesystem entry present under a known owned root with **no** ownership
record as `foreign`; a declared locator that will not hash as `gone`.

### New: `libs/install-engine/src/reconcile.ts`
```ts
export type ReconcileStatus = 'installed' | 'missing' | 'drifted' | 'foreign';
export interface ReconcileReport {
  perExtension: Array<{ id: string; status: ReconcileStatus; lock: boolean; installed: boolean;
    checksumMatch: boolean | null }>;
  lockOnly: string[];      // in lockfile, not installed   (SR-16, both directions)
  installedOnly: string[]; // installed, not in lockfile
  stubs: string[];         // installed with no resolvable extension manifest (flagged)
}
/** READ-ONLY (B-I7). Reuses verifyIntegrity + the ownership index + host dirs. */
export function reconcile(scope: DataScope, root?: string): Promise<ReconcileReport>;
```

### New: `libs/host-runtime/src/retention.ts`
```ts
export interface RootsModel { liveGenerations: string[]; lockEntries: string[]; runningPids: number[]; }
export interface RetentionPolicy { maxAgeMs: number; maxBytes?: number; graceMs: number; trashDir: string; }
export type RetentionClass = 'snapshot' | 'deployed-generation' | 'scratch';
export interface RetentionPlan { reclaim: Array<{ path: string; class: RetentionClass; bytes: number;
  reason: string }>; protected: Array<{ path: string; root: string }>; unmanaged: string[];
  totalBytes: number; }
/** READ-ONLY planner. An artifact with a matching root is `protected`. A tree with NO roots model
 *  is `unmanaged` and is NEVER eligible (B-I6 / SR-12). */
export function planRetention(dir: string, roots: RootsModel, policy: RetentionPolicy): RetentionPlan;
/** Separate, deliberate act. Moves eligible paths into `trashDir` (soft), records a manifest;
 *  `sweepTrash(trashDir, now)` physically deletes entries older than `graceMs`. Never touches a
 *  protected/unmanaged path. */
export function applyRetention(plan: RetentionPlan, policy: RetentionPolicy): Promise<void>;
export function sweepTrash(trashDir: string, now?: number): string[];
```

### `apps/sox/src/main.ts` — CLI surface (typed, no env toggles — ADR-0013)
`soxe drift [--scope s] [--json]` · `soxe repair [--scope s] [--confirm]` (separate act; prints exactly
what it will change) · `soxe reconcile [--scope s] [--json]` · `soxe gc [--dir p] [--apply --confirm]`
(report-first; `--apply` calls `applyRetention` — mirrors `tools/snapshot-gc.mjs`'s report-first shape).

## Behavioral changes
- **`install.ts` `recordOwnership`:** remove the `try/catch` that logs-and-continues. Load with
  `OwnershipIndex.loadFromFile(path, { strict: true })`; on failure throw a typed
  `OwnershipWriteError` (names ext, scope, cause). The call site already runs *after* placement —
  keep that ordering explicit (B-I2); on a thrown error the install fails loudly rather than shipping an
  untracked artifact.
- **`install.ts` lockfile sync:** `writeLockfileAtomic` → `atomicWriteFileSync`; the empty-
  lockfile refusal is kept. The swallowing `catch` becomes a typed warning surfaced on
  the install result (`lockSyncWarning`), never silent.
- **`OwnershipIndex.save`:** wrapped in `withReconciledRetry` (AC1). The pre-rename guard remains an
  optimisation; correctness is the rename.
- **Migration of legacy entries:** a one-time `soxe repair --backfill-hashes` computes `contentHash` for
  every `file-drop`/`materialize` entry lacking one and persists; until then those entries report
  `unverifiable`, never `still-valid`.
- **`claude-agents/tools/authoring/extraction-gate.mjs` (B-I8 / AC7):** a checkable gate consumed by the
  `user-thinking` `generalize` action (`tools/skills/user-thinking/SKILL.md:45`). `generalize` refuses
  unless the proposal cites **≥2 independent instances** (distinct `path`s / distinct call sites, not two
  spellings of one). The gate is a pure function over a proposal record so it is unit-testable.
- **git-manager (blocked phase):** `extensions/agents/git-manager/git-manager.md` is updated to consume
  `<project>/docs/GIT-POLICY.md` and to refuse a git op it cannot bind to a policy clause. **Blocked by
  items 1–3** (drift/reconcile must exist first) — not in the critical path.

## Migration
1. **Additive:** `atomic-write.ts`, `drift.ts`, `reconcile.ts`, `retention.ts` land first; no writer
   changes. Old fixed `.tmp` residue on disk is inert and ignored (never read).
2. **Writer flip:** `writeOwnershipAtomic`/`writeLockfileAtomic` switch to `atomicWriteFileSync`; readers
   become strict. Any call site that relied on the empty-on-error fallback is updated in the same change
   (grep `readOwnership(` under `libs/install-engine` and `apps/sox`).
3. **Hash backfill:** `soxe repair --backfill-hashes`. `unverifiable` count is reported before and after;
   the migration is complete only when it reaches zero for managed entries.
4. **Retention:** ships **report-only**; `--apply` is gated on a proven restore path for the snapshot
   class per **ADR-0014 D5 (proposed-only)**. For non-snapshot classes the roots model still requires an
   explicit `--apply --confirm`.
5. **No env vars:** all knobs (`RetentionPolicy`, grace, floors) are typed config fields, default-safe
   (ADR-0013). Rollback: readers accept both hash-bearing and hash-less entries, so a partial migration is
   never bricked.

## Acceptance criteria → test → negative control
| AC | Test (real entrypoint) | Negative control (must go RED) |
|---|---|---|
| AC1 two concurrent installs both persist | Two **real OS processes** (`fork`/`spawn` the CLI, not threads) install different extensions into one `ownership.json`; assert file parses and **both** records present. Barrier: both wait on a file-signal, then race — no sleeps. | Revert `writeOwnershipAtomic` to `filePath + '.tmp'`; the same two-process test observes a torn/absent record → RED. |
| AC2 re-run idempotent + ordering under injected failure | Re-run install; assert same addressed artifact, no duplicate entry, no second effect. Inject a throw **between** the materialize effect and `recordOwnership`; assert the artifact exists and is **untracked**, and a following `soxe reconcile` names it — never tracked-and-absent. | Write the marker first, then effect; inject the same failure → a tracked-but-absent record appears → RED. |
| AC3 drift verdicts by hash | Same-size, same-mtime edited file ⇒ `drifted`; deleted declared target ⇒ `gone`; untracked file at a managed path ⇒ `foreign`; unchanged ⇒ `still-valid`. | Replace hash comparison with `mtime`/`size`; the same-size same-mtime file reports `still-valid` → RED. |
| AC4 detect mutates nothing | Snapshot every managed file's bytes+hash; run `detectDrift`; assert byte-identical, no new/moved files. | Have `detectDrift` write a `.last-run` cache; the no-write assertion → RED. |
| AC5 retention never deletes a root | Referenced artifact (listed in a lock entry / live generation) is never reclaimed; unreferenced one is trashed and survives the grace window; `planRetention` dry-run mutates nothing. | Remove the roots check so an auto-clean runs without a roots model → a rooted artifact is deleted → RED. |
| AC6 lock ↔ installed reconciliation | Drop an installed agent from the lock ⇒ reported `lockOnly`; declare a missing target ⇒ `missing`; an extension-less stub ⇒ `stubs`. | Reconcile by reading only the lock ⇒ a lock missing an installed agent passes → RED. |
| AC7 extraction gate refuses single instance | Gate accepts a 2-instance proposal; refuses a 1-instance one with a typed reason. | Bypass the gate (generalize directly) ⇒ the single-instance proposal is accepted → RED. |
| SR-8 malformed index is loud | Corrupt `ownership.json`; `install`/`readOwnership` throws a typed error naming the file. | Restore `{owned: []}` on parse error ⇒ `install` reports success over an empty index → RED. |
| ADR-0003 frozen-lockfile fails on drift | Mutate the built artifact; `--frozen-lockfile` fails. | Revert to key-presence-only check ⇒ mutation passes → RED. |

## Concurrency proof standard
AC1 and AC2 use **two real OS processes** with a file-signal barrier (or `Atomics.wait` on a
`SharedArrayBuffer` latch), never `setTimeout`/sleep. Assertions key on **process exit codes**, not
stdout. The non-cooperative-writer test spawns a second process that writes `ownership.json` with a
plain `writeFileSync` mid-race and asserts the first process's result still parses and contains its own
record (B-I1).

## Blast radius
- **High:** `ownership.ts` (reader default change is breaking for any empty-on-error caller),
  `install.ts` `recordOwnership` (best-effort → loud changes install-failure semantics),
  `writeLockfileAtomic`. Callers: `apps/sox/src/main.ts` (`cmdInstall` :1254, `cmdUninstall` :1851,
  `hostPlaceExtension` :1911), `verify-integrity.ts`, ADR-0004 reversibility gate
  (`nx test-e2e host-runtime`), `libs/install-engine` scope-parity suite.
- **Medium:** new CLI subcommands (additive); `libs/host-runtime/src/retention.ts` (new; overlaps
  `tools/snapshot-gc.mjs` — that tool stays the memory-snapshot-specific report and is **not** replaced).
- **Low:** `claude-agents` extraction gate (new, additive to `user-thinking`); git-manager doc (blocked).

## Segment order (rough token estimates; each independently shippable)
1. **S1 — `atomic-write.ts` + `ownership.ts` write path.** ~9k read / ~5k write. Dependency: none.
2. **S2 — `install.ts` `writeLockfileAtomic` + `recordOwnership` strict/loud; call-site audit.** ~12k read /
   ~4k write. Dependency: S1. (Do not start before S1 lands — a partial flip leaves one fixed temp.)
3. **S3 — `drift.ts` + `reconcile.ts` + readers strict.** ~10k read / ~6k write. Dependency: S1.
4. **S4 — `retention.ts` + `soxe gc/drift/repair/reconcile` wiring + report-only.** ~8k read / ~5k write.
   Dependency: S2, S3.
5. **S5 — hash backfill (`soxe repair --backfill-hashes`) + migration report.** ~6k read / ~3k write.
   Dependency: S3.
6. **S6 — `claude-agents` extraction gate (unblocked by default) and git-manager doc (blocked by S1–S3).**
   ~5k read / ~3k write.

## Explicitly not grounded / assumed (do NOT treat as verified)
- **Trash namespace path** (`.adhd/sox-ecosystem/trash/<class>/…`): **not grounded — assumed.** ADR-0004
  D2 lists `ext/<id>/`, `run/`, etc., but **no `trash/` directory is documented on disk.**
- **`contentHash` field name/shape on `file-drop`/`materialize`:** **not grounded — assumed.** The
  current union (`ownership.ts:31-50`) carries no per-entry hash for those two kinds; `appliedHash`
  exists only for config entries.
- **`withReconciledRetry` being sufficient for AC1 under ADR-0012:** **partly grounded** — ADR-0012
  establishes multi-process writes are possible but its guarantees are Turso-store-specific; it says
  nothing about a JSON file. Treat the merge-retry loop as the assumed mechanism and require the AC1
  two-process test to prove it.
- **A live advisory lock is proposed nowhere in this spec** — deliberately. If one is added, it must
  bound duplicate work only (B-I1).

## Citations
Citations: [sox-ecosystem @ main (dirty), architect/deepseek-flash, D-B 48d7dcea,
1: libs/install-engine/src/ownership.ts:111-135, 2: libs/install-engine/src/install.ts:586-601,
3: libs/install-engine/src/install.ts:2333-2414, 4: libs/install-engine/src/verify-integrity.ts:75-121,
5: libs/install-engine/src/diff.ts:60-67, 6: libs/install-engine/src/data-paths.ts:74,
7: apps/sox/src/main.ts:1254,1851,1911, 8: docs/decisions/0003-extension-identity-is-content-addressed.md,
9: docs/decisions/0004-data-root-placement-and-ownership-index.md,
10: docs/decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md,
11: docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md,
12: docs/decisions/0014-memory-snapshot-retention-policy.md, 13: tools/snapshot-gc.mjs:1-120,
14: claude-agents/install-agents.sh:19-21,543, 15: claude-agents/tools/skills/user-thinking/SKILL.md:45,
16: sox-ecosystem/extensions/agents/git-manager/git-manager.md:24]
