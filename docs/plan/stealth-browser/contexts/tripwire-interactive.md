# tripwire-interactive — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** tripwire-core · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-interactive`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The interactive and CLI surface is in the package with injected IO so every HITL and unlock behavior is unit-testable without spawning: `interactiveGate`, `confirmSolved`, `runUnlockCli`, `renderStatusText`, `statusJsonLine` and the single Node adapter `nodeTripwireIo`; the three consumer scenario suites simulate real use; the public surface is closed and snapshotted.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/resilience/resilience-core-tripwire/src/lib/{interactive,cli,render,node-io}.ts`, `packages/resilience/resilience-core-tripwire/src/test/unit/{interactive,cli,render}.spec.ts`, `packages/resilience/resilience-core-tripwire/src/test/unit/scenario-{request-builder,agent-search,unlock-cli}.spec.ts`; MODIFY `packages/resilience/resilience-core-tripwire/src/index.ts` (export lines only) and `packages/resilience/resilience-core-tripwire/src/test/unit/api-surface.spec.ts` (add the interactive names and the id `[tripwire-interactive.8]`).

- **Reference Pattern:** The tripwire specification `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/tripwire-spec.md` (copied to `docs/plan/stealth-browser/SPEC-tripwire.md`; read only the section named in each step): section 1 (the 31-feature inventory F1-F31 and its fixes), 3 (API and behavior rules), 4 (TW1-TW38). The three sources it unifies: `/Users/nix/dev/ai/scratch/agent-browser/search-tripwire.ts`, `/Users/nix/dev/projects/reverse-apis/packages/system/request-builder/src/lib/tripwire.ts` and `/Users/nix/dev/projects/reverse-apis/tools/unlock-tripwire/unlock-tripwire.ts`. The HITL loops: `/Users/nix/dev/ai/scratch/agent-browser/cdp-search.ts` lines 269-340 and 433-465; the unlock CLI: `/Users/nix/dev/projects/reverse-apis/tools/unlock-tripwire/unlock-tripwire.ts`; its spawn spec asserts `unlocked tripwire for testclient`, `no tripwire to unlock for testclient`, `No TTY|Confirmation mismatch`, `Usage:` (keep these strings).

- **Delta Spec:** `TripwireIo { isTTY; env; question(prompt): Promise<string | null>; out(line); err(line) }` is the only IO the interactive code touches (null means EOF or closed); `nodeTripwireIo()` is the one place under `src/lib` that reads `process.stdin`, `process.stdout` and `process.env`. `interactiveGate(tw, key, io)`: while tripped count a block, print the banner (key, reason, tripped at, blocked-by count, page), prompt `[retry/clear/abort]`; `abort` throws TripwireAbortedError and keeps the lock; `clear` clears with method `hitl-clear`; retry, Enter or ANY other input marks reverified, clears with `hitl-retry` and proceeds (unknown input still means retry: preserved); a closed stdin or non-TTY aborts, fail closed (the old loop hung on EOF). `confirmSolved(tw, key, info, io)`: banner (provider/key, query, reason, strategy, page, session id), "ENTER to retry or abort"; abort throws TripwireAbortedError('HITL aborted by user') and the lock stays for the next invocation; Enter marks reverified and clears. `runUnlockCli(argv, io, tw)` returns 0, 1 or 2 with the exact strings of the current bin; the audit method is `unlock-cli-tty` or `unlock-cli-env` (the `CONFIRM` env path). `renderStatusText` and `statusJsonLine` are pure: per-key block (reason, trippedAt, blockedCount, query, pageUrl, reverifiedAt?, resolvedAt?), `No tripwires tripped.`, and the final JSON line exactly `{"type":"tripwireStatus","status":{...}}`. The scenario suites run the three real flows end to end against the memory fs: request-builder (4xx trips, three blocked sends counted, confirm-token unlock, next send open, corrupt lock blocks, second 4xx keeps the first record), agent-search (captcha trips, locked responses, the HITL choices, TTL expiry removes lazily with an audit line, success resolves; `open` clear policy, expiry 2 h) and unlock-cli (every exit code).

- **Invariants:** [inv:one-new-package] ([def:tripwire-pkg]) [inv:greenfield] (legacy names and paths are not constraints) [inv:no-features-removed] (every feature F1-F31 is carried or its change is flagged D3) [inv:unit-purity] (no child_process, no network, no real home) [inv:tests-cite] [inv:typed-errors]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tripwire-interactive]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tripwire-interactive` — runs every acceptance criterion below (red until the work is done); `--only tripwire-interactive.N` runs one. `pnpm nx run resilience-core-tripwire:typecheck`, `:typecheck-spec`, `:lint`, `:test` (criterion .9).

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tripwire-interactive --only tripwire-interactive.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tripwire-interactive.1] TW24 `interactiveGate` (interactive.spec.ts): the banner content, `retry` / Enter / any other input gives reverified plus clear (method `hitl-retry`) and returns, `clear` gives `hitl-clear`, `abort` throws TripwireAbortedError with the lock kept, and each loop iteration counts one block.
- [tripwire-interactive.2] TW25 a non-TTY or a `question` that returns null (EOF) aborts with the lock kept and never hangs (interactive.spec.ts, fake io with no stdin).
- [tripwire-interactive.3] TW26 `confirmSolved`: Enter gives reverified plus cleared; `abort` throws TripwireAbortedError('HITL aborted by user') with the lock kept (interactive.spec.ts).
- [tripwire-interactive.4] TW27 `runUnlockCli` (cli.spec.ts and scenario-unlock-cli.spec.ts): no client prints usage and returns 1; no lock prints `no tripwire to unlock for X` and returns 0; reason, trippedAt, lastStatus and lastOperationId are printed with `(none)` fallbacks; an unparseable lock warns and proceeds; the TTY confirm path; the `CONFIRM` env path; a mismatch returns 1 with the lock kept; no TTY and no CONFIRM returns 1 with `No TTY`; a storage error returns 2; the audit method is `unlock-cli-tty` or `unlock-cli-env`.
- [tripwire-interactive.5] TW28 `renderStatusText` gives the per-provider layout and `No tripwires tripped.`; `statusJsonLine` is exactly `{"type":"tripwireStatus","status":{...}}`, is the last line of the status output, and the map is sparse with plain string keys (render.spec.ts).
- [tripwire-interactive.6] Scenario suite for the request-builder consumer (scenario-request-builder.spec.ts): a 4xx trips the key, three following sends are blocked and counted, the confirm-token unlock clears it and the next send is open; a corrupt lock blocks; a second 4xx keeps the first record.
- [tripwire-interactive.7] Scenario suite for the agent-search consumer (scenario-agent-search.spec.ts): a captcha trips the key, later searches get locked responses, the HITL loop offers retry, clear and abort, the TTL expiry removes the lock lazily with an audit line, and a successful search resolves the tripwire (`open` clear policy, expiry 2 h).
- [tripwire-interactive.8] The public surface is complete and closed: src/index.ts now also exports interactiveGate, confirmSolved, runUnlockCli, renderStatusText, statusJsonLine and nodeTripwireIo (plus their option and io types), api-surface.spec.ts snapshots exactly the section-3 export list (no consumer-specific names), and node-io.ts is the only file under src/lib that touches process.stdin, process.stdout or process.env (TW31).
- [tripwire-interactive.9] The package builds and passes whole: `nx run resilience-core-tripwire:typecheck`, `:typecheck-spec`, `:lint` and `:test` exit 0, every spec still cites the ticket and a criterion id (TW35), and only owned paths changed by [psm:tripwire-interactive] commits.

---

## Reservations

```text
read_only:  ["packages/resilience/resilience-core-tripwire/package.json", "packages/resilience/resilience-core-tripwire/src/lib/tripwire.ts", "packages/resilience/resilience-core-tripwire/src/lib/types.ts", "docs/plan/stealth-browser/SPEC-tripwire.md"]
mutates:    ["packages/resilience/resilience-core-tripwire/src/", "packages/resilience/resilience-core-tripwire/*"]
```

---

## Contract Promise

Added: the interactive modules and their specs under `packages/resilience/resilience-core-tripwire/`. Modified: `src/index.ts` exports and the api-surface snapshot (closed public surface, TW30).

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tripwire-interactive]`:

- [ ] After the interactive gate, confirmSolved and their specs — commit: `feat(resilience-core-tripwire): interactive gate and confirmSolved [psm:tripwire-interactive]`
- [ ] After the unlock CLI, rendering, nodeTripwireIo and the scenario suites — commit: `feat(resilience-core-tripwire): unlock CLI, rendering, scenarios [psm:tripwire-interactive]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Specs cite `8468f7b1`, a tripwire-interactive criterion id (tripwire-interactive.<n>) and the TW label; no spec imports child_process, net or http (the real unlock bin spawn assertion lives in the reverse repo).
- TW31: only `node-io.ts` may touch `process.stdin`, `process.stdout` or `process.env`; every other file receives a `TripwireIo`.
