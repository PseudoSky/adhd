# Doc Operations Log — @adhd/apigen-cli

## Log header
- Scope: `entrypoint/apigen-cli` (`@adhd/apigen-cli`)
- Steward run started: 2026-07-03
- Baseline SHA: e06cd253ee609d229ba7c00e8812a822ad424880

## Operations

### REVISE README.md — 2026-07-03
reason: Stale monorepo paths (packages/apigen/cli/ → entrypoint/apigen-cli/), missing `serve` command (the most complex feature), missing `--use`/`--config`/`--v2`/`--link-workspace` flags, incomplete plugin list (omitted py-flask, py-grpc), outdated --opt keys table. Per catalog doc-conformance: README had 8% junk, 5% redundant, 40% undocumented.

Full revised content replaces the old README.md verbatim.

removed (prior README.md — 150 lines):
```
# @adhd/apigen-cli

The user-facing CLI for **apigen** — take any `.ts` file and expose its exports as an
**MCP server, HTTP API (Fastify/Express), CLI, or JSON Schema**, with **zero changes to
the source**. Functions are the single source of truth; everything is derived.

> This documents the **v1** (TypeScript-only) implementation that ships today. The
> transport-neutral, polyglot **v2** standard is specified in
> [`docs/apigen/SPEC.md`](../../../docs/apigen/SPEC.md) and is in active build-out.

---

## Install / launch

The CLI is not bundled to `dist` by default. Use whichever fits:

```bash
cd <repo-root>

# A) Dev — run the TypeScript entry directly (no build):
alias apigen='npx tsx packages/apigen/cli/src/index.ts'

# B) Bundled bin — build once, then run dist (bin name: apigen-cli):
npx nx build apigen-cli
#   → node packages/apigen/cli/dist/index.js
```

**Commands:** `run`, `generate`, `run-registry`, `generate-registry`
**`--type` (target plugin):** `mcp` · `api-fastify` · `api-express` · `cli` · `jsonschema`
**Server knobs:** passed through repeatable `--opt key=value`.

A ready fixture lives at `packages/apigen/cli/src/test/fixtures/api.ts` (`getUser`, `sendEmail`),
used in the examples below.

---

## Run a live server — `run`

```bash
# MCP over stdio (default transport)
apigen run --source packages/apigen/cli/src/test/fixtures/api.ts --type mcp

# MCP over HTTP transports
apigen run --source .../api.ts --type mcp --opt transport=sse             --opt port=3000
apigen run --source .../api.ts --type mcp --opt transport=streaming-http  --opt port=3000

# HTTP API (Fastify or Express) — --namespace sets the route prefix segment
apigen run --source packages/apigen/cli/src/test/fixtures/api.ts \
  --type api-fastify --namespace api --opt port=3000
```

Call an HTTP server — **method must be uppercase `POST`**, arguments wrapped in
`{"data":{…}}` (the request envelope), route is `/<namespace>/<fn>`:

```bash
curl -X POST http://127.0.0.1:3000/api/getUser \
  -H 'content-type: application/json' \
  -d '{"data":{"userId":"abc"}}'
# → {"id":"abc"}
```

### `--opt` keys read by the server plugins

| key           | targets                                               | default     | meaning                                |
| ------------- | ----------------------------------------------------- | ----------- | -------------------------------------- |
| `transport`   | `mcp`                                                 | `stdio`     | `stdio` \| `sse` \| `streaming-http`   |
| `port`        | `mcp` (http transports), `api-fastify`, `api-express` | `3000`      | listen port                            |
| `host`        | `mcp` (http), `api-fastify`, `api-express`            | `127.0.0.1` | bind host                              |
| `routePrefix` | `api-fastify`, `api-express`                          | `""`        | path prefix before `/<namespace>/<fn>` |

`mcp` over `stdio` keeps **stdout** clean for the JSON-RPC channel — all logs go to stderr.

---

## Generate to disk — `generate`

```bash
# MCP server source
apigen generate --source packages/apigen/cli/src/test/fixtures/api.ts \
  --type mcp --out-dir /tmp/apigen-out
node /tmp/apigen-out/server.ts          # or: npx tsx /tmp/apigen-out/server.ts

apigen generate --source .../api.ts --type api-fastify --out-dir /tmp/out-http    # routes.ts
apigen generate --source .../api.ts --type cli         --out-dir /tmp/out-cli     # cli.ts
apigen generate --source .../api.ts --type jsonschema  --out-dir /tmp/out-schema  # *.json
```

Generated servers import `dispatch`/`buildFnTable` from `@adhd/apigen-runtime` — no inlined
dispatch logic — so disk output behaves identically to `run`.

---

## Multi-package — `run-registry` / `generate-registry`

Discover packages in a directory by **nx tag** and wire them into one surface:

```bash
apigen run-registry --packages-dir packages/apigen/cli/src/test/fixtures/registry \
  --tag api --type mcp
apigen generate-registry --packages-dir <dir> --tag api --type mcp --out-dir /tmp/reg-out
```

`--tag` / `--exclude-tag` are repeatable; untagged exports stay out of the surface.

---

## Flags

### Export shapes — `--export`

- _(omit)_ — named exports (`export function f`, `export const f = …`).
- `--export default` — a default-exported function/object.
- `--export <objName>` — a named object whose properties are the operations.

> **Known v1 limitations (tracked, fixed by v2):** `export { x as y }` aliases,
> anonymous default exports, and CJS-source files mis-name routes because v1 names by the
> _declaration_ identifier rather than the _exported symbol_. v2 (`docs/apigen/SPEC.md`)
> names by exported symbol and closes these.

### Resolution

- `--tsconfig <path>` — explicit tsconfig; otherwise the nearest one, else a builtin default.
- `--namespace <name>` — the package id / route prefix segment. Defaults to the tsconfig
  folder name, falling back to the source file's folder.

### Plugin options

- `--opt key=value` — repeatable; forwarded to the target plugin (see table above).

### Logging (stderr — stdout stays protocol-clean)

- `--log-level trace|debug|info|warn|error|fatal|silent` (env `APIGEN_LOG_LEVEL`)
- `--log-format json|pretty` (env `APIGEN_LOG_FORMAT`)
- `--log-file <path>` — write logs to a file instead of stderr (env `APIGEN_LOG_FILE`)

Lifecycle logged: compile → server start → host/port → route/tool list → per-request → shutdown.

---

## Nx integration

- Cache-aware generate target: `@adhd/apigen-nx:generate` (see [`../nx`](../nx)).
- Scaffold a new output plugin: `nx g @adhd/apigen-nx:plugin <name>`.

## Develop

```bash
npx nx build apigen-cli      # bundle
npx nx test  apigen-cli      # Vitest (unit + integration)
```
```

### CREATE AGENTS.md — 2026-07-03
reason: Missing LLM-guiding document. Required per CLI-scope bundle. Strictly factual, no marketing.

### CREATE CHANGELOG.md — 2026-07-03
reason: Missing per-package changelog. Required for a published npm CLI package. Based on BACKLOG.md and git log.

### CREATE CONTRIBUTING.md — 2026-07-03
reason: Missing contributor guide. Required per CLI-scope bundle. Build, test, develop instructions.

### CREATE LICENSE — 2026-07-03
reason: Missing license file. Repo root is MIT. Following pattern from packages/apigen/apigen-core-client/LICENSE.

### CREATE llms.txt — 2026-07-03
reason: Missing LLM machine-readable summary. Required per CLI-scope bundle.

### REVISE README.md (2nd pass) — 2026-07-03
reason: User feedback — missing npx install path (npx @adhd/apigen-cli), missing value proposition for what you can BUILD (polyglot microservices, AI tool servers, deployable projects), missing "what you get" section showing generated project tree, unclear nx generator purpose (scaffolds framework plugins like nestjs). Rewrote with npx-first install, "What you can build" section, generated project tree, clearer middleware/layer plugin story.

### FIX BACKLOG.md link — 2026-07-03
reason: Broken link — `../../../BACKLOG.md` resolved outside repo. Fixed to `../../BACKLOG.md` (one level up from entrypoint/apigen-cli/ to repo root).

### CREATE consumer.md — 2026-07-03
reason: Consumer test report for reviewer gate. Saved doc-consumer output to .catalog/consumer.md.
