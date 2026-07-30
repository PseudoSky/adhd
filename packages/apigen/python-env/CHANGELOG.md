## 0.2.1 (2026-07-27)


### 🩹 Fixes

- **apigen-python-env:** ship the `apigen_python` sources into `dist/python/` via a vite `writeBundle` copy plugin and resolve them co-located-first, so `py-grpc`/`py-flask` work for consumers installing from npm outside the monorepo (BUG-015). `project.json` `build.options.assets` was a no-op under `@nx/vite:build`.


## 0.1.5 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.4 (2026-07-24)

This was a version bump only for apigen-python-env to align it with other projects, there were no code changes.

## 0.1.3 (2026-07-24)

This was a version bump only for apigen-python-env to align it with other projects, there were no code changes.

## 0.1.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries


### ❤️  Thank You

- pseudosky

## 0.1.1 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries


### ❤️  Thank You

- pseudosky