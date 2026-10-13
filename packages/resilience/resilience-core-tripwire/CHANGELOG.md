# Changelog

## 0.1.0

First release of `@adhd/resilience-core-tripwire`: a persistent kill-switch
latch, extracted from the reverse-apis request builder and the agent-search
tripwire so all three consumers share one implementation.

### Features

- `createTripwire(options)` returns a latch with `read`, `gate`, `assertOpen`,
  `trip`, `clear`, `resolve` and `status`. Keys are validated before any IO.
- Lock-file protocol under `<stateDir>/tripwire/<key>.lock`: atomic
  create-if-absent, first trip wins, tmp-then-link writes, files `0600` and
  directories `0700`.
- Fail closed: only an absent lock is clear; an empty, corrupt, unknown-schema
  or unreadable lock counts as tripped. `trip` never throws on IO and an
  in-memory latch keeps the process blocked when the lock cannot be written.
- Per-generation block counters (`<key>.blocked.<generation>` sidecars): the
  count of one trip never leaks into the next, and counting never rewrites the
  lock.
- Clear policies: `confirm-token` (default, needs `CONFIRM_TOKEN`) and `open`.
  `resolve` for the success path, optional `expiry` with lazy removal.
- `.cleared` marker consumed by the next trip and recorded as `priorClear`.
- Capped NDJSON audit trail with six events (`tripwire-fired`,
  `tripwire-gate-blocked`, `tripwire-retripped`, `tripwire-cleared`,
  `tripwire-resolved`, `tripwire-expired`); lines are under 4 KB and never carry
  the lock context.
- Redaction: `defaultRedactor()` drops credential-looking keys, strips secret
  query parameters and URL credentials, truncates long strings and never
  persists `responseBody` or `responseStatus`; a custom `redact` composes after it.
- Typed errors with stable codes (`TRIPWIRE_TRIPPED`, `TRIPWIRE_CONFIRM_REQUIRED`,
  `TRIPWIRE_INVALID_KEY`, `TRIPWIRE_IO`, `TRIPWIRE_ABORTED`) and brand-based
  guards `isTripwireError` and `isTripwireTrippedError` that work across
  duplicate copies of the package.
- Human-in-the-loop: `interactiveGate` and `confirmSolved` over an injected
  `TripwireIo`; they abort with the lock kept on no TTY or EOF and never hang.
- `runUnlockCli` for a five-line unlock bin, `renderStatusText` and
  `statusJsonLine` for status output, and `nodeTripwireIo`, the single Node
  adapter of the IO seam.
- `adhdDataDir` resolves `<ADHD_HOME>/...` (default `~/.adhd`) as a pure
  function of the environment you pass.
- Storage seam: `createFileStorage`, `createMemoryStorage` and `createNodeFs`,
  plus `createMemoryFs`, an in-memory `FsPort` with failure injection for tests.
- Zero runtime dependencies, CommonJS, Node 20 or newer, one entry point.

### Documentation

- README with install, three consumer recipes, `stateDir` and `ADHD_HOME`, clear
  policies, redaction, failure behavior and the local-disk caveat. Every `ts`
  example is compiled and executed by `readme-examples.spec.ts`.
- `docs/ERRORS.md`: each error code with its class, cause and remediation.
- `docs/RECOVERY.md`: operator runbook with the break-glass `rm`, the sidecars,
  the unlock bin and how to read the audit log.
