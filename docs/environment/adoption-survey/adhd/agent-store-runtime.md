---
package: @adhd/agent-store-runtime
path: /Users/nix/dev/node/adhd/packages/agent/agent-store-runtime
root: adhd
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: [{path: "database (injected)", kind: "unknown", purpose: "SQLite via better-sqlite3/drizzle-orm"}]
config_files: []
supported_by_env: no
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None read.

**Writes:** 
- SQLite database operations (insert, update, delete) via injected `BetterSQLite3Database` connection. The actual database location is determined and passed in by the consuming host (e.g., agent-mcp entrypoint).

**Config files:** None referenced.

**Scope behavior:** This package makes zero decisions about paths, env vars, or config files. All configuration (database location, logger instance, hook registry) is **injected via constructor**, making this a pure library with no environmental concerns of its own.

## Proposed `EnvironmentSpec`

Not applicable. This is a library/data-access layer. The entrypoint that consumes this package (likely `@adhd/agent-mcp` or a similar host) owns configuration decisions.

## Gap detail

No gaps. The package correctly delegates all environmental concerns upstream to its consumer.

## File-location table

| current path | kind | proposed env.paths/env.files key |
|---|---|---|
| Database (injected via constructor) | data | N/A — host concern |

## Recommendation

**Skip adoption.** `@adhd/agent-store-runtime` is a library providing data-access interfaces. It takes configuration (database connection, logger, hooks) as injected dependencies, not from environment or files. Configuration responsibility belongs entirely to the host/entrypoint that instantiates and uses these stores. Adopting `@adhd/environment` here would be premature and wrong-scoped. The pattern is correct: library accepts config via DI, host decides where config comes from (via `@adhd/environment` or otherwise).
