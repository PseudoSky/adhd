---
package: "@adhd/sox-service-proxy"
path: /Users/nix/dev/ai/sox-ecosystem/libs/service-proxy
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: parameter-driven
env_vars: []
writes: [{path: "opts.socketPath (directory)", kind: "run", purpose: "UDS listener socket directory"}, {path: "opts.socketPath (file)", kind: "run", purpose: "UDS listener socket"}, {path: "lockDir (derived from socketPath or opts.lockDir)", kind: "run", purpose: "spawn lock directory"}, {path: "proxy-backend-*.lock (in lockDir)", kind: "run", purpose: "atomic O_EXCL spawn coordination lock"}, {path: "opts.stderrLogPath (if provided)", kind: "logs", purpose: "detached backend stderr redirection"}]
config_files: []
supported_by_env: no
gaps: []
value: low
effort: high
recommend: skip
---

## Current state

**Environment variables:** None read by this package. No direct `process.env.*` access.

**Writes:**
- `opts.socketPath` directory (created 0o700 by caller's mkdirSync in serveBackend/ensureBackend, via `path.dirname()`)
- `opts.socketPath` file (UDS socket, chmodmed 0o600, unlinked on close)
- Lock directory (defaults to `path.dirname(opts.socketPath)`, or `opts.lockDir` if provided) created 0o700
- Lock file (`proxy-backend-{hash}.lock`) within lock directory — JSON payload with pid/timestamp/key, atomic create-or-fail via fs.openSync('wx')
- `opts.stderrLogPath` (if provided) — opened in append mode, inherited by child process, then immediately closed by parent

**Config files:** None. All configuration is passed as function parameters.

**Current scope behavior:** Parameter-driven. All paths, env vars to spawn, diagnostics callbacks, and timeouts are passed to `serveBackend()` and `ensureBackend()` as options objects. The package is a leaf library — it does not read environment, does not discover paths, does not manage defaults. The CALLER (the service-proxy front-shim, or consumer of the ensure-backend flow) is responsible for deciding where sockets, locks, and logs live.

## Proposed `EnvironmentSpec`

Not applicable. This package is a library that delegates all configuration to its caller via function parameters. It has zero built-in runtime-configuration surface. The caller would be the appropriate target for @adhd/environment adoption.

```typescript
// Not applicable — this is a parameter-driven leaf library.
// No EnvironmentSpec needed; configuration is caller-determined.
```

## Gap detail

None identified. The package is already zero-config in design — all paths and env vars are caller-provided. There is no runtime-configuration surface to adopt.

## File-location table

| current path | kind | proposed env.paths/env.files key | notes |
|---|---|---|---|
| `opts.socketPath` (dir) | run | N/A — caller decides | Caller determines socket directory; package mkdir's the parent |
| `opts.socketPath` (file) | run | N/A — caller decides | UDS socket file — lifecycle managed by package, location caller-provided |
| `opts.lockDir` or `path.dirname(opts.socketPath)` | run | N/A — caller decides | Spawn lock directory; defaults to socket parent if not specified |
| `proxy-backend-{hash}.lock` | run | N/A — caller decides | Atomic O_EXCL lock for singleton spawn coordination |
| `opts.stderrLogPath` | logs | N/A — caller decides | Optional detached-backend stderr redirection; package does not default it |

---

## Rationale

This package (`sox-service-proxy`) is a **zero-config dependency-free leaf library**. It provides two core functions:

1. **`serveBackend(opts)`** — starts a UDS listener on `opts.socketPath` and relays framed JSON-RPC to a handler.
2. **`ensureBackend(opts)`** — idempotent singleton guardian: ensures exactly one backend is live on a socket, spawning it detached if absent, with O_EXCL locking for coordination under concurrent shims.

**All configuration is caller-provided:**
- Socket path, lock directory, stderr log path — caller decides
- Environment variables passed to spawned child — caller provides the full `opts.env` object
- Timeouts, diagnostic callbacks — all options
- The package reads ZERO environment, creates ZERO config files, and has ZERO hardcoded paths

**Recommendation:** **SKIP** adoption. This is a library, not a service. The appropriate target for @adhd/environment adoption is the **caller** — the entity that uses `ensureBackend()` to spawn a backend and must decide where to place its socket, lock, and logs. A consumer service (e.g., the sox-ecosystem's MCP host or service-proxy orchestrator) would be the candidate for adopting @adhd/environment; this library simply executes what the consumer decides.
