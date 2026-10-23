# Spec: per-instance memory footprint for backlog and agent-mcp

Status: proposed. Owner: unassigned. Plan: see the PLAN item in the backlog (uid recorded there).

## 1. Problem

Each Claude session starts its own instance of the backlog MCP server and the agent-mcp server. Each instance's resident memory is far above what its job needs, and the cost multiplies with session count.

Measured on this machine (macOS, Node v24.11.1):

| Measurement | RSS | Source |
|---|---|---|
| Bare Node process (empty script) | 43.7 MB | `req-probe.cjs` baseline |
| `memory-server` MCP (non-apigen), idle 0–90 s | 45–51 MB | `probe-memory.jsonl` |
| `backlog` global `@adhd/backlog@1.0.19`, boot | 95–144 MB | `probe-bl-global.jsonl`, `ab-B` |
| `backlog` repo build, `require` only | 107 MB max RSS | `/usr/bin/time -l node -e "require('./dist/index.js')"` |
| `backlog` global, `require` only | 104 MB max RSS | same |
| `backlog` global, 60 s telemetry tick, copied history | 144 → 718 MB | `probe-B*.jsonl`, heap snapshots |
| `search` (apigen MCP), boot, flat to 60 s | 580 MB | `probe-search.jsonl` |
| agent-mcp `src/db/client.ts` import | 44 → 266 MB | earlier probe; **unverified, re-measure in A1** |

Per-package `require` cost (fresh process, dist entry):

| Package | RSS delta | Modules |
|---|---|---|
| `apigen-core-client` | +1.9 MB | few (ts-morph already lazy) |
| `apigen-engine-runtime` | +14.9 MB | 102 |
| `apigen-engine-gateway` | +33.2 MB | 254 |
| `ajv` alone | +10.4 MB | 67 |
| `zod` alone | +13.8 MB | ~97 |
| `@modelcontextprotocol/sdk` server or client | +30–31 MB | includes zod |
| `typescript` / `ts-morph` | +76 MB / +104 MB | — |

Root causes, each with a source citation:

1. **Telemetry rollup re-reads and retains all snapshot history every 60 s.** `sox-telemetry/src/runtime.ts:1334–1397` (`readSnapshotRecords`) parses every snapshot JSONL on each tick and keeps records in `rt.rollupFileCache`. Heap diff across one tick: +199,905 `metrics.snapshot` records, +3.77M `Object`. Tracked in `137f67de`.
2. **Eager top-level requires of heavy third-party packages.** 13 built packages require `ajv`, `pino`, or the MCP SDK at import. `apigen-engine-runtime/src/lib/validate-layer.ts:34–36, 79–80` imports ajv and builds an `Ajv` instance at module scope; `apigen-engine-runtime/src/lib/logger.ts:1–2` imports pino statically for call-time use. Tracked in `29759c46`.
3. **Bundles keep externals at top level and inline apigen.** `entrypoint/backlog/dist/index.js` has no `require("@adhd/apigen-*")`; apigen code is compiled inline, while pino, fastify, ajv, the MCP SDK, and sox packages stay external and load at boot. A source fix in `packages/apigen/` therefore reaches backlog only on rebuild and republish. (Recorded on `29759c46`.)
4. **Heavy compilers loaded at boot.** The global backlog bundle loads `typescript` and `ts-morph` eagerly. Tracked in `9c75ac4c`.
5. **apigen cold IR extraction.** A fresh root runs ts-morph extraction at startup: ~600 MB transient, ~3 s. Tracked in `12e06ed6`.
6. **The 60 s timer cannot be disabled by env.** `SOX_TRACE_SNAPSHOT_MS` is read only when it parses to a number greater than 0 (`sox-telemetry/dist/runtime.js:845–852`); `0` falls back to the 60 s default. The interval is armed only when the resolved value is above 0 (`:883–890`). Disabling requires the typed `snapshotEveryMs: 0`. Tracked in `acce8aa6` (successor `37b817bc`).
7. **agent-mcp default-loads tracing unconditionally** (`0f760dcd`, in progress) and loads the engine compiler and orchestrator at boot.

## 2. Target

- **Per-instance steady-state RSS ≤ 50 MB** for backlog `serve --transport mcp` and agent-mcp `serve`, measured by the gate in §5.
- **Honest floor:** bare Node is 43.7 MB here, so 50 MB leaves ~6 MB. Budget step B1 must confirm that the transport plus tool table fits this headroom. If B1 shows it does not, the gate threshold is revised to the measured floor plus a stated margin, and that revision is a decision recorded on the PLAN item, not a silent change.
- **CLI one-shot commands** have a separate budget: ≤ 80 MB RSS, since they do not run a server. Set in B1.
- The 60 s tick must not grow RSS by more than 5 MB across 90 s with history present.

Non-goals: changing the backlog or agent-mcp public tool surface; changing the store schema; removing tracing (it is constrained, not removed, under A3).

## 3. Approach

Ordered by measured payoff and dependency:

1. **Measure before changing** (B1, A1). Produce a per-module boot table for each entry point so every later step has a number.
2. **Remove the largest always-on cost**: the telemetry rollup and its history read (B5, with `137f67de`). Moving it out of the server process makes the 60 s growth zero for every instance.
3. **Make transports and store lazy** (B2, B3, A2, A4): one-shot CLI does not load fastify, the MCP SDK, or the store; `serve` loads only its transport; the store and embedding stack load on first use.
4. **Make validators and loggers lazy** (S1 covers ajv, pino, MCP SDK across 13 packages; backlog inherits via its bundle).
5. **Bake the apigen IR at build and ship it** (B6, `12e06ed6`), so ts-morph does not run at runtime.
6. **Rebuild and republish** (B7) so consumers receive the fixes. A fix that is not republished does not reach an installed copy.
7. **Constrain tracing** (A3, `0f760dcd`): default-load stays, but tracing must not allocate a history reader at boot and must honor its budget.
8. **Decide the process model** (S2): a shared daemon serves all sessions with one process, which removes the N× multiplier. This is a design decision for the user, not an implementation step in this plan.

## 4. Work items

Each item below is a backlog child of the PLAN (`part_of`). Dependencies are `blocks` edges.

### Backlog (entrypoint/backlog, project `adhd`)

- **B1 — Boot attribution and budget table.** Bisect each top-level require of the repo build and the global bundle in a fresh process; record RSS delta per module; produce `docs/plan/memory-footprint/budget-backlog.md`. No code change. *AC:* table covers every top-level require; the sum of deltas plus baseline matches the `require`-only total within 5 MB; the table states the boot floor for `serve --transport mcp`.
- **B2 — Split entry points.** One-shot CLI commands do not import fastify, the MCP SDK, or the store. `serve --transport mcp` imports only the MCP SDK and its tool table. `serve --transport http` imports fastify. *AC:* CLI `--help` and one read op stay within the CLI budget; MCP serve boot does not load fastify (verified by module list); behavior of every public verb unchanged (existing tests green).
- **B3 — Lazy store and embedding stack.** `sox-graph-store`, `sox-store-adapter`, `sox-hybrid-search`, and the embedding provider load on first call that needs them. *AC:* `tools/list` on MCP serve does not load the store; first read op loads it; measured RSS after `tools/list` is within the B1 floor plus 5 MB.
- **B5 — Telemetry rollup out of process.** The rollup runs as a scheduled or one-shot job that reads snapshot history incrementally by byte offset and streams, keeping aggregates only. The MCP server records snapshots but does not read history. Child of `137f67de`. *AC:* no `readSnapshotRecords`-equivalent call in the server process (verified by the 60 s probe); 90 s RSS delta with history present ≤ 5 MB; rollup output identical to the in-process version on a fixture history (golden test).
- **B6 — Bake apigen IR at build and ship.** Child of `12e06ed6`. *AC:* a fresh root with no cache serves `tools/list` without ts-morph loading; the baked artifact is in the published package; cold-root RSS reported by the gate.
- **B7 — Rebuild, republish, and gate.** Republish backlog with B2–B6. Install the published package into a clean prefix and run the §5 gate against it. *AC:* gate green against the installed artifact, not the repo build.

### Shared packages (cross-repo)

- **S1 — Lazy ajv, pino, MCP SDK across 13 packages.** Child of `29759c46`. Covers `apigen-engine-runtime` (validate-layer, logger), `apigen-engine-gateway`, and the plugins listed on that item. Memoize the `Ajv` instance; lazy-require the SDK inside the gateway's upstream sources. *AC:* each package's `require` RSS delta is below the value recorded in §1 minus the eager module's cost; existing tests green; no behavior change in validation output (golden test on a fixture set of schemas).
- **S2 — Process-model decision: shared daemon.** Architect decision, not implementation. Output: an ADR-style record with the trade-offs (per-session copies vs one shared process, connection lifetime, crash isolation, auth). *AC:* decision recorded and linked to this PLAN; the user approves or rejects it.

### Telemetry (sox-ecosystem)

- **B5 tracking:** `137f67de` (rollup cache retention). `acce8aa6` (override not honored in the shipped bundle) is a prerequisite for the gate, since the gate must run the 60 s tick with history.

### Agent-mcp (entrypoint/agent-mcp, project `adhd`)

- **A1 — Re-measure the DB import and attribute agent-mcp boot.** Run `src/db/client.ts` import alone; determine whether the +222 MB includes migration or schema work at import; produce the agent-mcp boot table. *AC:* table with per-module deltas; the 222 MB figure is either confirmed with a cause or corrected in this spec.
- **A2 — Lazy SQLite open.** Open the connection on first use. *AC:* `serve` boot does not open the database; first DB op opens it; no schema change; existing DB tests green.
- **A3 — Constrain default tracing.** Child/relates of `0f760dcd`. Tracing stays default-loaded (per its ticket), but must not construct its history reader at boot and must stay within the boot budget. *AC:* agent-mcp boot RSS with tracing loaded is within budget; the 60 s tick (if any) does not grow RSS.
- **A4 — Lazy engine compiler and orchestrator.** Load `agent-engine-compiler` and `agent-engine-orchestrator` on first agent run. *AC:* `tools/list` does not load them; first run loads them; behavior unchanged.
- **A5 — Entry point CLI/serve split.** Relates to `333656c6`. Same principle as B2. *AC:* as B2, for agent-mcp.
- **A6 — Gate.** Child of PLAN. Runs §5 against agent-mcp serve. *AC:* green against the built artifact.

## 5. Verification gate

One probe, reused for every instance, that behaves like a host:

1. Start the built server as a child process over stdio (real JSON-RPC: `initialize`, `notifications/initialized`, `tools/list`).
2. Call one read-only operation.
3. Sample RSS at boot+3 s, after the op, and at 20/40/60/90 s with a copied history present.
4. Assert: steady-state RSS ≤ the target in §2; 90 s growth ≤ 5 MB; exit code 0 for every step.
5. Run against the repo build and the published artifact. The gate fails if either is over budget.
6. The probe is deterministic: no fixed sleeps beyond the sampling schedule; it keys on the exit code, not stdout.

The probe is the existing `mcp-probe.mjs` pattern in the scratchpad. It moves into the repo under `tools/` as part of B1, or to whichever location the repo's test-infrastructure rules name.

## 6. Risks

- **The target may sit below the Node floor plus a working transport.** Mitigated by B1 measuring first, and by the explicit revision path in §2.
- **Lazy loading moves cost to first use.** A user's first op pays the load. The gate must measure first-op latency as well, so the trade-off is visible.
- **Republish lag.** Installed copies stay on old versions until they upgrade. B7 is required for consumers to see any of this.
- **Behavior drift in lazy validation.** Mitigated by golden tests in S1.
- **Shared daemon changes the failure model.** Recorded as S2, not decided here.

## 7. Done

The PLAN is done when every child item is resolved with a citation to its passing gate run, the §5 gate is green against the published artifact of backlog and agent-mcp, and S2 has a recorded decision.
