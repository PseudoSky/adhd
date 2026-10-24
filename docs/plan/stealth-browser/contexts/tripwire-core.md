# tripwire-core — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** tripwire-scaffold · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-core`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The unified tripwire core exists, is correct under adversarial interleavings and is proven by unit specs alone: one storage seam (`TripwireStorage`) with a file and a memory implementation, a deterministic memory-fs interleaving harness, `createTripwire` (read, gate, assertOpen, trip, clear, resolve, status), typed errors with stable codes and a brand, the default redactor, the capped NDJSON audit and `adhdDataDir`. Every feature F1-F31 of the three sources is carried and every defect found in them (spec section 1) is fixed in the one implementation, never wrapped.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/resilience/resilience-core-tripwire/src/index.ts`, `packages/resilience/resilience-core-tripwire/src/lib/{types,errors,redact,paths,storage,memory-fs,audit,tripwire}.ts`, `packages/resilience/resilience-core-tripwire/src/test/unit/{tripwire,storage,storage-contract,legacy,redact,expiry,clear,audit,errors,paths,interleave,api-surface}.spec.ts` and `packages/resilience/resilience-core-tripwire/src/test/support/`. Zero runtime dependencies; no `process`, `console` or env access under `src/lib` (the interactive IO adapter is the next state).

- **Reference Pattern:** The tripwire specification `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tripwire-spec.md` (copied to `docs/plan/stealth-browser/SPEC-tripwire.md`; read only the section named in each step): section 1 (the 31-feature inventory F1-F31 and its fixes), 3 (API and behavior rules), 4 (TW1-TW38). The three sources it unifies: `/Users/nix/dev/ai/scratch/agent-browser/search-tripwire.ts`, `/Users/nix/dev/projects/reverse-apis/packages/system/request-builder/src/lib/tripwire.ts` and `/Users/nix/dev/projects/reverse-apis/tools/unlock-tripwire/unlock-tripwire.ts`. Also the research trace `/Users/nix/dev/ai/scratch/.research-trace/2026-10-12-file-latch.md` (create-if-absent by `link`, atomic replace, O_APPEND counters, fail closed).

- **Delta Spec:** Implement the unified latch exactly as section 3 of the spec: `types.ts` (JsonValue, TripContext, `CONFIRM_TOKEN`, ClearMethod, TripwireStatus, TripwireRecord, TripwireSnapshot, Redactor, TripwireOptions, TripInput, TripResult, GateResult, ClearOptions, Tripwire), `errors.ts` (TripwireError with a stable `code` and the brand `Symbol.for('adhd.tripwire.error')`; TripwireTrippedError with `fromRecord`, TripwireConfirmError, TripwireKeyError, TripwireIoError, TripwireAbortedError; `isTripwireError`, `isTripwireTrippedError` by code and brand, safe across duplicate copies), `redact.ts` (`defaultRedactor`: drops values for keys matching `/authorization|cookie|set-cookie|token|secret|password|x-auth/i`, strips secret-looking URL query params, truncates strings over 2048 characters), `paths.ts` (`adhdDataDir(segments, env?, home?)`, `ADHD_HOME ?? ~/.adhd`, pure, no env read), `storage.ts` (`TripwireStorage`, `createFileStorage` over an injected `FsPort`, `createMemoryStorage` as the reference implementation of the contract), `memory-fs.ts` (`FsPort` and `createMemoryFs` with inspection and deterministic interleaving hooks, an ~80-line port replacing memfs), `audit.ts` (NDJSON lines under 4 KB, byte-accurate cap `maxAuditBytes` default 5 MiB / minimum 100000, keep the newest half from a line boundary, unique tmp then atomic rename, best-effort with `onWarning`), `tripwire.ts` (`createTripwire`) and `src/index.ts`. Behavior rules (spec 3.1, normative): key regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` before any fs call; `read` treats only ENOENT as clear and every other read error, empty file, bad JSON or wrong shape as `unreadable` (fail closed, synthesized record reason `unreadable-lock`); legacy flat shapes are read (unknown top-level fields move into `context`, the in-record `blockedCount` adds to the sidecar count); `trip` sets the in-memory latch FIRST, consumes the `<key>.cleared` marker into `priorClear`, persists create-if-absent (unique tmp `wx` 0600 fsync then `link(tmp, lock)`, EEXIST means lost race, fall back to `open wx` where hard links are unsupported), keeps the first record on a second trip (audit `tripwire-retripped`, `created: false`) and never throws on IO (`persisted: false` plus `onWarning`); `gate` lazily removes an expired lock (tombstone rename then unlink, audit `tripwire-expired`), counts a block through the O_APPEND sidecar `<key>.blocked` (size is the count) so an increment can never create or modify the lock, audits `tripwire-gate-blocked`, and consults the in-memory latch; `assertOpen` throws TripwireTrippedError with a `recoveryHint` naming the clear method of the policy; `clear` under `confirm-token` needs `CONFIRM_TOKEN` else TripwireConfirmError with no state change, an absent lock returns `{ cleared: false }` with no audit, success writes the `.cleared` marker, tombstones the lock, removes the sidecar and audits `tripwire-cleared` with method, actor and reverified; `resolve` audits `tripwire-resolved` (trippedAt, durationMs, blockedCount) then clears with method `resolved` (no token, both policies); `status` is a sparse plain-string-keyed record that hides expired unless `includeExpired`. Files are 0600 and directories 0700 (chmod pre-existing directories), fsync before rename or link. The package reads no environment variable and uses no `console`. Every spec cites `8468f7b1`, its tripwire-core criterion id (tripwire-core.<n>) and its TW label.

**Required literal tokens per spec file** (the guard reads each spec and requires the label, the criterion id and these tokens verbatim, so put them in test names or comments):

| Criterion | Label | Spec file (under `src/test/unit/`) | Required tokens |
|---|---|---|---|
| tripwire-core.1 | TW1 | `tripwire.spec.ts` | `created`, `tripwire-retripped` |
| tripwire-core.2 | TW2 | `storage.spec.ts` | `.tmp`, `interleav` |
| tripwire-core.3 | TW3 | `tripwire.spec.ts` | `unreadable`, `EACCES`, `EIO`, `assertOpen` |
| tripwire-core.4 | TW4 | `legacy.spec.ts` | `lastStatus`, `lastOperationId`, `reverifiedAt`, `blockedCount` |
| tripwire-core.5 | TW5 | `tripwire.spec.ts` | `TRIPWIRE_INVALID_KEY` |
| tripwire-core.6 | TW6 | `storage.spec.ts` | `0o600`, `0o700` |
| tripwire-core.7 | TW7 | `redact.spec.ts` | `authorization`, `cookie`, `responseBody` |
| tripwire-core.8 | TW8 | `tripwire.spec.ts` | `sessionId`, `trippedBy`, `browserSessionId` |
| tripwire-core.9 | TW9 | `tripwire.spec.ts` | `gate`, `open` |
| tripwire-core.10 | TW10 | `tripwire.spec.ts` | `tripwire-gate-blocked`, `TripwireTrippedError`, `recoveryHint` |
| tripwire-core.11 | TW11 | `interleave.spec.ts` | `blockedCount` |
| tripwire-core.12 | TW12 | `interleave.spec.ts` | `gate`, `clear` |
| tripwire-core.13 | TW13 | `expiry.spec.ts` | `tripwire-expired`, `includeExpired`, `ttlMs` |
| tripwire-core.14 | TW14 | `clear.spec.ts` | `TripwireConfirmError`, `CONFIRM_TOKEN` |
| tripwire-core.15 | TW15 | `clear.spec.ts` | `mcp-clear`, `open` |
| tripwire-core.16 | TW16 | `clear.spec.ts` | `cleared` |
| tripwire-core.17 | TW17 | `clear.spec.ts` | `priorClear` |
| tripwire-core.18 | TW18 | `clear.spec.ts` | `tripwire-resolved`, `reverified` |
| tripwire-core.19 | TW19 | `audit.spec.ts` | `tripwire-fired`, `tripwire-gate-blocked`, `tripwire-cleared`, `tripwire-resolved`, `tripwire-expired`, `tripwire-retripped` |
| tripwire-core.20 | TW20 | `audit.spec.ts` | `maxAuditBytes`, `multibyte` |
| tripwire-core.21 | TW21 | `audit.spec.ts` | `auditPath` |
| tripwire-core.22 | TW22 | `audit.spec.ts` | `onWarning` |
| tripwire-core.23 | TW23 | `tripwire.spec.ts` | `persisted`, `TRIPWIRE_IO` |

`api-surface.spec.ts` carries BOTH `[tripwire-core.24]` and (added by `tripwire-interactive`) `[tripwire-interactive.8]`. Criteria .24-.32 are the surface, purity, errors, error payload, citation, interleaving, paths, storage-contract and build checks (TW30-TW33, TW35-TW38 and the whole-core build).

- **Invariants:** [inv:one-new-package] ([def:tripwire-pkg]) [inv:greenfield] (legacy names and paths are not constraints) [inv:no-features-removed] (every feature F1-F31 is carried or its change is flagged D3) [inv:unit-purity] (no child_process, no network, no real home) [inv:tests-cite] [inv:typed-errors]. [inv:live-chrome] is vacuous here. The unit lane spawns nothing (ADR-0009): real two-process contention is NOT proven; TW36 proves the logic under adversarial interleavings of the exact fs operations (open item OD-TW1 in the spec). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-core]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-core` — runs every acceptance criterion below (red until the work is done); `--only tripwire-core.N` runs one. `pnpm nx run resilience-core-tripwire:test`, `:typecheck`, `:typecheck-spec` and `:lint` (criterion .32); `guard.py tripwire-core --only tripwire-core.N` per criterion.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-core --only tripwire-core.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-core.1] TW1 second `trip` on a tripped key returns `created: false`, the first record (reason, trippedAt, context) is untouched and `tripwire-retripped` is audited; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW1).
- [tripwire-core.2] TW2 writes use unique tmp names (pid plus random); two interleaved writers never share a tmp name and a reader at any interleaving point sees complete JSON or ENOENT; proven in src/test/unit/storage.spec.ts (cites ticket 8468f7b1, the id and TW2).
- [tripwire-core.3] TW3 fail closed: ENOENT is clear; EACCES, EIO, an empty file, garbage JSON and a wrong schema are tripped with status `unreadable` and `assertOpen` throws; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW3).
- [tripwire-core.4] TW4 legacy reverse-shaped and search-shaped locks (including the in-record blockedCount and reverifiedAt) are read and honored, extra fields land in `context` and the counts add; proven in src/test/unit/legacy.spec.ts (cites ticket 8468f7b1, the id and TW4).
- [tripwire-core.5] TW5 keys `..`, `a/b`, empty, 65 characters and a leading dot are rejected with TRIPWIRE_INVALID_KEY before any fs call; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW5).
- [tripwire-core.6] TW6 lock, sidecar and audit files are 0600 and directories 0700, including pre-existing directories (chmod); proven in src/test/unit/storage.spec.ts (cites ticket 8468f7b1, the id and TW6).
- [tripwire-core.7] TW7 redaction: denylisted header, cookie and token keys dropped, URL query secrets stripped, long strings truncated, a custom redactor composed after the default, `responseBody` never written, the audit never contains query text; proven in src/test/unit/redact.spec.ts (cites ticket 8468f7b1, the id and TW7).
- [tripwire-core.8] TW8 context round-trips both consumers' fields (`lastStatus`, `lastOperationId` and `query`, `pageUrl`, `strategy`, `browserSessionId`, `lastOperation`) and `sessionId()` lands in `trippedBy`; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW8).
- [tripwire-core.9] TW9 `gate` on a clear key is open with zero writes and zero audit lines; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW9).
- [tripwire-core.10] TW10 `gate` on a tripped key is closed, the count rises by one and `tripwire-gate-blocked` is audited; `assertOpen` throws TripwireTrippedError with key, reason, trippedAt Date, record, recoveryHint and code; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW10).
- [tripwire-core.11] TW11 N interleaved gates give `blockedCount === N` exactly (no lost updates); proven in src/test/unit/interleave.spec.ts (cites ticket 8468f7b1, the id and TW11).
- [tripwire-core.12] TW12 a block racing a clear never recreates the lock; after the clear the lock is absent; proven in src/test/unit/interleave.spec.ts (cites ticket 8468f7b1, the id and TW12).
- [tripwire-core.13] TW13 with `expiry`, an older-than-TTL lock is open, lazily removed with one `tripwire-expired` audit; without `expiry` it never expires; `status` hides expired unless `includeExpired` (one rule for CLI and MCP); proven in src/test/unit/expiry.spec.ts (cites ticket 8468f7b1, the id and TW13).
- [tripwire-core.14] TW14 `confirm-token` policy: a missing or wrong token throws TripwireConfirmError with the lock intact and no cleared audit; the correct token clears and the audit has method and actor; proven in src/test/unit/clear.spec.ts (cites ticket 8468f7b1, the id and TW14).
- [tripwire-core.15] TW15 `open` policy clears without a token and audits method `mcp-clear`; proven in src/test/unit/clear.spec.ts (cites ticket 8468f7b1, the id and TW15).
- [tripwire-core.16] TW16 clear on an absent lock returns `{ cleared: false }`, does not throw and audits nothing; proven in src/test/unit/clear.spec.ts (cites ticket 8468f7b1, the id and TW16).
- [tripwire-core.17] TW17 clear writes the marker; the next trip carries `priorClear` and the marker is consumed once; proven in src/test/unit/clear.spec.ts (cites ticket 8468f7b1, the id and TW17).
- [tripwire-core.18] TW18 `resolve` audits `tripwire-resolved` with durationMs and blockedCount, then removes; the `reverified` flag appears on the cleared audit event; proven in src/test/unit/clear.spec.ts (cites ticket 8468f7b1, the id and TW18).
- [tripwire-core.19] TW19 audit: one valid NDJSON line per event with ts, event, key and namespace; fired, gate-blocked, cleared, resolved, expired and retripped are all emitted; each line is under 4 KB; proven in src/test/unit/audit.spec.ts (cites ticket 8468f7b1, the id and TW19).
- [tripwire-core.20] TW20 audit cap: at or above `maxAuditBytes` the oldest half is dropped at a line boundary, byte-accurate with multibyte lines, the newest kept, the replace atomic, the log never above the cap after an append, and an append interleaved with rotation loses no complete line other than the dropped half; proven in src/test/unit/audit.spec.ts (cites ticket 8468f7b1, the id and TW20).
- [tripwire-core.21] TW21 audit dir is `dirname(auditPath)`; the default is under `stateDir`; an `auditPath` outside stateDir works; nothing is written under the real home; proven in src/test/unit/audit.spec.ts (cites ticket 8468f7b1, the id and TW21).
- [tripwire-core.22] TW22 an audit write failure never throws from `gate`, `trip` or `clear` and `onWarning` is called; proven in src/test/unit/audit.spec.ts (cites ticket 8468f7b1, the id and TW22).
- [tripwire-core.23] TW23 a persist failure on `trip` gives `persisted: false` and a TRIPWIRE_IO warning, and a same-process `gate` is still closed; proven in src/test/unit/tripwire.spec.ts (cites ticket 8468f7b1, the id and TW23).
- [tripwire-core.24] TW30 public surface: src/index.ts exports createTripwire, adhdDataDir, CONFIRM_TOKEN, defaultRedactor, TripwireTrippedError, TripwireConfirmError, TripwireAbortedError, isTripwireTrippedError, createMemoryFs, createFileStorage, createMemoryStorage and the types of the spec (Tripwire, TripwireOptions, TripwireRecord, TripwireSnapshot, TripwireStorage, FsPort, Redactor, ClearMethod, TripContext); no consumer-specific name (`provider`, `client`) appears in an exported type name; api-surface.spec.ts snapshots `Object.keys(require index)`; the package has no subpath export.
- [tripwire-core.25] TW31 purity: no `process.env`, `process.stdin`, `process.stdout`, `child_process` or `console.*` appears in non-comment lines of packages/resilience/resilience-core-tripwire/src/lib outside node-io.ts, and no source file imports node:net, node:http, node:https or node:child_process; the package reads no environment variable (adhdDataDir takes `env` as a parameter).
- [tripwire-core.26] TW32 errors: every error class has a stable `code` and a brand; errors.spec.ts proves `isTripwireTrippedError` is true for a structural clone standing in for an instance from a duplicate module copy, and each error's code is one of the registry (TRIPWIRE_TRIPPED, TRIPWIRE_CONFIRM_REQUIRED, TRIPWIRE_ABORTED, TRIPWIRE_INVALID_KEY, TRIPWIRE_IO).
- [tripwire-core.27] TW33 `TripwireTrippedError.fromRecord(record, { responseStatus, responseBody })` exposes typed `responseStatus` and `responseBody` fields; neither is ever serialized by `trip` or written to the lock or the audit (errors.spec.ts and redact.spec.ts).
- [tripwire-core.28] TW35 every spec under src/test cites ticket 8468f7b1 and a criterion id of a state that owns the tripwire package ([tripwire-<state>.N], or [fix-tripwire.N] / [conform-tripwire.N] for the specs those later states added) plus a TW id, and no spec imports child_process, net or http.
- [tripwire-core.29] TW36 interleaving suite over the memory-fs hooks: trip/trip, gate/gate, gate/clear, clear/clear, trip/clear and audit rotate/append hold their invariants (TW1, TW11, TW12, TW20) in interleave.spec.ts.
- [tripwire-core.30] TW37 `adhdDataDir(['reverse','data'], { ADHD_HOME: '/x' })` is `/x/reverse/data`; with no env it is `<home>/.adhd/reverse/data`; the function is pure (paths.spec.ts).
- [tripwire-core.31] TW38 the storage contract suite (storage-contract.spec.ts) runs identically on `createMemoryStorage`, `createFileStorage` over the memory fs and `createFileStorage` over a real `mkdtemp` directory; create-if-absent uses link with an `open wx` fallback (a memory fs that rejects `link` is covered).
- [tripwire-core.32] The core builds and passes alone: the files src/lib/{types,errors,redact,paths,storage,memory-fs,audit,tripwire}.ts and src/index.ts exist, `nx run resilience-core-tripwire:typecheck`, `:typecheck-spec`, `:lint` and `:test` exit 0, and only owned paths changed by [psm:tripwire-core] commits.

---

## Reservations

```text
read_only:  ["packages/resilience/resilience-core-tripwire/package.json", "packages/resilience/resilience-core-tripwire/project.json", "packages/resilience/resilience-core-tripwire/vite.config.ts"]
mutates:    ["packages/resilience/resilience-core-tripwire/src/", "packages/resilience/resilience-core-tripwire/*"]
```

---

## Contract Promise

Added: the core under `packages/resilience/resilience-core-tripwire/src/`. No consumer-specific names (`provider`, `client`) appear in any exported type. The CLI, HITL and rendering surface is `tripwire-interactive`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-core]`:

- [ ] After types, errors, redact, paths and the memory fs with specs — commit: `feat(resilience-core-tripwire): types, errors, redaction, paths, memory fs [psm:tripwire-core]`
- [ ] After storage, audit and the contract suite — commit: `feat(resilience-core-tripwire): storage seam and capped audit [psm:tripwire-core]`
- [ ] After createTripwire, legacy reads and the interleaving suite — commit: `feat(resilience-core-tripwire): the latch [psm:tripwire-core]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Behavior changes versus the sources are deliberate and approved (D3): a corrupt or unreadable lock BLOCKS; blocked sends are counted and audited; every trip and clear is audited; a second trip keeps the first record; the dead `reverifiedAt` / `resolvedAt` lock writes become audit information (F9).
- Order: types, errors, redact, paths, memory-fs, storage (+TW2, TW6, TW38), audit (+TW19-TW22), tripwire (+the rest), index (+TW30), interleave (+TW36).
- Keep audit lines under 4 KB and never audit query text or `context` except a redacted `pageUrl`.
- `createMemoryFs` is a hand-written fake with hooks to pause an operation at a named point; do not add memfs or any other dependency.
