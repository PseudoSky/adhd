## 0.2.2 (2026-07-30)


### 🩹 Fixes

- **apigen:** schema extraction required-array + CLI mount/discriminated-union gaps


### ❤️  Thank You

- pseudosky

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-plugin-cli-output to align it with other projects, there were no code changes.

## 0.1.7 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-24)

This was a version bump only for apigen-plugin-cli-output to align it with other projects, there were no code changes.

## 0.1.4 (2026-07-24)


### 🚀 Features

- **apigen-plugin-cli-output:** migrate to TransportAdapter over OpPlan.cliFlags


### 🩹 Fixes

- **apigen-plugin-cli-output:** reword run.ts doc comments to avoid literal "project(" substring


### ❤️  Thank You

- pseudosky

## 0.1.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining @adhd/apigen-runtime refs → apigen-engine-runtime

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** BUG-APIGEN-031 — CLI generate output JSON.parse array/object domain params

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

- **apigen:** update remaining @adhd/apigen-runtime refs → apigen-engine-runtime

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** BUG-APIGEN-031 — CLI generate output JSON.parse array/object domain params

- **environment:** correct agent-mcp plugins at: classification (build->runtime)

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky