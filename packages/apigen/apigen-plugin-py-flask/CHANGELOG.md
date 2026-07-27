## 0.1.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-24)

This was a version bump only for apigen-plugin-py-flask to align it with other projects, there were no code changes.

## 0.1.4 (2026-07-24)


### 🚀 Features

- **apigen-plugin-py-flask:** TS-computed-plan extract/serve split


### 🩹 Fixes

- **apigen:** guarantee py-flask/py-grpc test subprocess teardown

- **apigen:** use ephemeral ports for py-flask/py-grpc test servers


### ❤️  Thank You

- pseudosky

## 0.1.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **environment:** correct agent-mcp plugins at: classification (build->runtime)

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **environment:** correct agent-mcp plugins at: classification (build->runtime)

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky