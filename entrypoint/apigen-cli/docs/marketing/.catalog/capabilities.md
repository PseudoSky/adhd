# @adhd/apigen-cli — Capabilities

Generated: 2026-07-03 from `e06cd253`

## Classification

- **Package:** `@adhd/apigen-cli`
- **Version:** 0.1.0
- **Type:** `cli` · `entrypoint`
- **Tags:** `layer:entrypoints`, `platform:node`

## CLI Commands (5)

| Command | Status | Target Plugins | Substance |
|---------|--------|----------------|-----------|
| `apigen run` | shipped | mcp, api-fastify, api-express, cli, py-flask, py-grpc | substantial |
| `apigen generate` | shipped | mcp, api-fastify, api-express, cli, jsonschema | substantial |
| `apigen run-registry` | shipped | all run-capable plugins | moderate |
| `apigen generate-registry` | shipped | all generate-capable plugins | moderate |
| `apigen serve` | shipped | api-fastify, py-flask, py-grpc | substantial |

## Feature Inventory (21 capabilities)

| # | Capability | Status | Substance | Key Feature |
|---|-----------|--------|-----------|-------------|
| 1 | `cli-run` — Live server from source | shipped | substantial | Dual v1/v2 paths, non-TS plugin bypass, 3 precondition guards |
| 2 | `cli-generate` — Generate artifacts to disk | shipped | substantial | Dep-manifest pipeline (DESIGN §14.1), resolution scaffolding |
| 3 | `cli-run-registry` — Multi-package live server | shipped | moderate | Single-call aggregation of discovered packages |
| 4 | `cli-generate-registry` — Multi-package generation | shipped | moderate | |
| 5 | `cli-serve` — Multi-source, multi-language front | shipped | substantial | Protocol-peeking demux, orphan-free teardown, partial availability |
| 6 | `plugin-system` — Output plugin architecture | shipped | substantial | 7 registered plugins, language-based extraction routing |
| 7 | `use-plugin-loader` — --use plugin loading | shipped | moderate | Built-in slugs, dynamic import fallback |
| 8 | `v2-orchestrator` — Unified detect→extract→merge→run | shipped | substantial | Shared ExtractionSession, collision detection |
| 9 | `v1-pipeline` — Legacy pipeline backward compat | shipped | moderate | |
| 10 | `registry-discovery` — Package discovery by nx tag | shipped | trivial | |
| 11 | `resolution-scaffolding` — Output resolution scaffolding | shipped | substantial | Copied @adhd/* source (not symlinks), idempotent |
| 12 | `dep-manifest` — Per-surface dependency manifest | shipped | moderate | Recursive format collection, tsDepMap() |
| 13 | `fail-fast-guards` — Precondition guards | shipped | moderate | 0-function check, decimal.js check, non-TS bypass |
| 14 | `tsconfig-resolution` — TypeScript config resolution | shipped | moderate | Memoized builtin, nearest walk |
| 15 | `logging-system` — pino-based CLI logging | shipped | moderate | stderr-only, env fallbacks |
| 16 | `serve-multiprotocol` — HTTP/1.1 + gRPC/h2c mux | shipped | substantial | Socket peeking, h2c session caching, grpc trailer forwarding |
| 17 | `serve-health-model` — Partial availability health | shipped | substantial | Per-host status, aggregated /_meta/health |
| 18 | `serve-python-integration` — Python host management | shipped | moderate | Pre-provisioned venv, APIGEN_PYTHON pinning |
| 19 | `projection-override` — Tenet 1 out-of-source config | shipped | trivial | |
| 20 | `export-mode-selection` — named/default/named-object | shipped | trivial | |
| 21 | `orphan-free-teardown` — SIGTERM→SIGKILL escalation | shipped | moderate | |

## Verification Summary

- **20 shipped** · **0 roadmap** · **0 deprecated**
- **7 substantial** implementations (engines, not wrappers)
- **0** capabilities marked `🔴 UNVERIFIED` (all are proven at the code level)
- Test coverage: Vitest spec files at `src/test/` and `src/lib/` with integration and unit tests

## Plugin Targets

| Plugin ID | Package | Language | Run? | Gen? |
|-----------|---------|----------|------|------|
| `mcp` | @adhd/apigen-plugin-mcp | ts | ✓ | ✓ |
| `jsonschema` | @adhd/apigen-plugin-jsonschema | ts | ✗ | ✓ |
| `api-fastify` | @adhd/apigen-plugin-api-fastify | ts | ✓ | ✓ |
| `api-express` | @adhd/apigen-plugin-api-express | ts | ✓ | ✓ |
| `cli` / `cli-output` | @adhd/apigen-plugin-cli-output | ts | ✓ | ✓ |
| `py-flask` | @adhd/apigen-plugin-py-flask | py | ✓ | ✓ |
| `py-grpc` | @adhd/apigen-plugin-py-grpc | py | ✓ | ✓ |
