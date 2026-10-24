# Approval: three-package split (stealth-core-browser, stealth-search, resilience-core-tripwire)

Approver: the user (direction relayed by the dispatcher, dispatch dispatch-2026-10-12-ca18). Recorded 2026-10-13.

Verbatim request: "port search to the entrypoint transfering all the apigen / tracing requirements over to the cli and mcps for search (which is built on top of the stealth core. Rename the entrypoint stealth search and the cdp to stealth core browser. Similar target slightly more work in the entrypoint, actual purpose. no need to do a full phase on confirming the logs just have an agent fully validate that they are being written - tests are unneeded"

## Decision

The plan builds three packages, each produced by the workspace generator, and no fourth:

1. `packages/resilience/resilience-core-tripwire` (`@adhd/resilience-core-tripwire`, approved in `APPROVAL-tripwire.md`).
2. `packages/stealth/stealth-core-browser` (`@adhd/stealth-core-browser`, tier core, new `stealth` workspace group): the renamed CDP/Chrome runner.
3. `entrypoint/stealth-search` (`@adhd/stealth-search`): agent-search ported onto the core, with the library, CLI and MCP stdio hosts and the apigen tracing requirements (namespace `adhd`).

Release order: tripwire, then core, then search, then `consumer-relink`.

## Consequences recorded

- No dependency-approval gate: `turndown`, `pdfjs-dist` and `commander` are commodity dependencies of the search entrypoint, and the sox packages are owned. `APPROVALS.md` states this.
- `tracing-log-validation` replaces any tracing-validation phase: one validating agent reads the log files the built bins wrote; no tests.
- `surface-hosts`, `tracing-plugin`, `tracing-namespace-proof`, `agent-search-cutover` and `agent-search-relink` are retired (`retire-state` entries in `state.json` amendment_log) and replaced by the `search-*`, `tracing-log-validation`, `search-cutover` and `consumer-relink` states.
