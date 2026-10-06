# dispatch-orchestrator

This library was generated with [Nx](https://nx.dev).

## Liveness and process guards

- **Liveness heartbeats** — `OrchestratorDeps.liveness = { deadlineMs, nowMs? }`. Every dispatched
  task is registered with a `LivenessMonitor`; each answered poll is a heartbeat. A task whose polls
  stop answering for longer than `deadlineMs` after its last heartbeat is marked dead and its unit
  failed (`PollOutcome.dead`) instead of polling to the full `poll.timeoutMs`. `nowMs` is injectable,
  so the deadline is provable without sleeping.
- **Duplicate-dispatch guard** — `acquireDispatchLock(lockPath, identity)` refuses
  (`DuplicateDispatchError`) a second live holder of the same identity, across processes (exclusive
  file create + owner-pid liveness; a dead owner's lock is reclaimed). `dispatch run` takes one per dag file.
- **Child reaper** — `ChildReaper({ maxRssBytes?, idleMs?, nowMs?, rssBytesOf?, kill? })` reaps tracked
  children over the resident-memory ceiling or idle past the deadline on `sweep()`.

## Building

Run `nx build dispatch-orchestrator` to build the library.

## Running unit tests

Run `nx test dispatch-orchestrator` to execute the unit tests via [Vitest](https://vitest.dev/).
