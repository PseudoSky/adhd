# Logging and tracing: where it goes and how to read it

`agent-mcp` writes three kinds of operational record for every task, plus the task rows in its
SQLite store. All four are keyed by the same `task_id`, all of them live under one per-user
namespace (`~/.adhd/agent-mcp/production/`), and none of them contains a credential. This guide
shows how to find them, what is in them, and how to trace one task from the raw upstream call to
the cost in the database.

Every command below was run against the production store on 2026-10-09 (server built from
`feat/tracing-live`, tasks run through the real server). Output shown is real, trimmed only where
marked `...`. Spec trail: backlog `c536ce29`. Related guides:
[dev-server-local-testing.md](./dev-server-local-testing.md) (start, drive and stop a server),
[provider-call-audit.md](./provider-call-audit.md) (what is sent to a provider per turn).

- [Where things live](#where-things-live)
- [The channels and their records](#the-channels-and-their-records)
- [Correlation: one id across logs and DB](#correlation-one-id-across-logs-and-db)
- [Tailing and querying](#tailing-and-querying)
- [Cost and pricing data](#cost-and-pricing-data)
- [Redaction guarantees](#redaction-guarantees)
- [Configuration knobs](#configuration-knobs)
- [Proving it live: the env-gated test](#proving-it-live-the-env-gated-test)
- [Worked traces](#worked-traces)
- [Known gaps](#known-gaps)

## Where things live

Paths come from `resolveLogRoots()` (`src/config.ts`) over the `@adhd/environment` cascade, with
the scope forced to `global` so `ADHD_ENV_SCOPE=project` can never move logs into a repo. With no
overrides the production namespace is:

| What | Path |
|---|---|
| Operational DB (agents, tasks, events, usage, prices) | `~/.adhd/agent-mcp/production/data/agents.db` |
| Raw wire log (`api`) | `~/.adhd/agent-mcp/production/logs/api/` |
| Core-ops log (`ops`) | `~/.adhd/agent-mcp/production/logs/ops/` |
| Spans and metrics (`trace`) | `~/.adhd/agent-mcp/production/logs/trace/` |
| Credential-bearing scratch (claudecli mcp-config, agent spec, srt policy) | `~/.adhd/agent-mcp/production/temp/` |
| Dev-server pid and supervisor log | `<checkout>/tmp/agent-mcp/serve/serve-<port>.{pid,log}` |

```console
$ ls ~/.adhd/agent-mcp/production/logs
api
ops
trace
$ ls ~/.adhd/agent-mcp/production/logs/ops | tail -3
agent-mcp.ops-2026-10-09.default.7580.jsonl
agent-mcp.ops-2026-10-09.default.80321.jsonl
agent-mcp.ops-2026-10-09.default.82149.jsonl
```

File names are `<component>-<UTC date>.<instanceLabel>.<pid>.jsonl` (rotated files gain `.gz`).
One process owns one file, so concurrent servers never share an open file. The `trace` files are
named by the telemetry library instead: `agent-mcp.live-service-<date>.jsonl` (spans) and
`agent-mcp.live-service.metrics-snapshot-<date>.jsonl` (metrics).

Retention and size caps are per channel (see [knobs](#configuration-knobs)); the oldest files are
removed first.

## The channels and their records

Each line is one JSON object. Common envelope on every channel: `ts` (UTC ISO), `level`, `event`,
`pid`, `stream`, `service`, `release` (`git_sha`, `artifact_sha256` of the running build) and
`trace_id` (null on `api` and `ops`).

### `api` - the raw wire (what went to and came from a provider, and what a client sent)

Hybrid durability: records up to 64 KiB are written synchronously, larger ones through a bounded
queue. Bodies are captured up to `logging.apiBodyMaxBytes` (4 MiB) with the sha256 of the full body.

| `event` | Meaning | Notable fields |
|---|---|---|
| `http.request` / `http.response` | Outbound call to an HTTP provider (Anthropic API, OpenAI-compatible, the pricing feed) | `call_id`, `task_id`, `session_id`, `agent`, `method`, `url`, `headers` (secrets redacted), `body`; response: `status`, `ttfb_ms`, `latency_ms`, `chunk_count`, streamed `body` |
| `spawn.start` / `spawn.stdin` / `spawn.stdout` / `spawn.exit` / `spawn.close` | A subprocess provider (the `claude` CLI) | `command`, `args`, per-line `body`, `code`, `duration_ms`, `stdout_bytes`, `stdout_sha256` |
| `mcp.request` / `mcp.response` / `mcp.error` | Inbound MCP `tools/call` handled by the server | `tool`, `mcp_session_id`, `request_id`, `is_error`, `duration_ms`, `body` |
| `http.inbound.request` / `http.inbound.response` | The streamable-HTTP and SSE routes | `route`, `method`, `url`, `status`, `body_bytes` |
| `mcp.send` / `mcp.recv` / `mcp.close` | Server-to-tool-server traffic (fs, shell, ...) | |

### `ops` - what the engine decided (always on, `sync` durability, survives `kill -9`)

| `event` | Fields beyond the envelope |
|---|---|
| `server.start`, `server.listening`, `server.stop`, `server.shutdown` | `reason`, `signal`, `uptime_ms` |
| `task.start` | `session_id`, `task_id`, `root_task_id`, `agent`, `provider`, `model`, `depth`, `messages` |
| `turn.start` / `turn.end` | `turn`, `messages`, `tools`; end: `stop_reason`, `tool_calls`, `input_tokens`, `output_tokens`, `response_model`, `compute_ms`, `duration_ms` |
| `tool.call`, `tool.denied`, `cap.trip`, `hitl.suspend`, `hitl.resume`, `provider.error`, `dispatch.delegate`, `session.created`, `session.closed` | task ids plus event-specific detail |
| `task.completed` / `task.failed` / `task.cancelled` | `duration_ms`, `turns`, `input_tokens`, `output_tokens`, `result_chars` |
| `pricing.pull.start`, `pricing.pull.end`, `pricing.anomaly`, `pricing.scheduler.*` | `ledger_id`, `models`, `changed`, `anomalies` |

The persisted pino application log is also written to `ops` (lines with numeric `level`, `msg`,
no `event`), so a `TASK_COMPLETED` line appears next to the structured `task.completed`.

### `trace` - spans

One span per task and per model call, from `@adhd/agent-plugin-tracing`: `agent.task.start`,
`agent.model_call.start`, `agent.model_call.finish`, `agent.task.finish` (and tool/permission/HITL
spans). Fields use dotted names: `agent.task_id`, `agent.session_id`, `agent.root_task_id`,
`agent.name`, `agent.model_call.input_tokens`, ..., plus `trace_id` (a ULID), `span_id`,
`otel_trace_id`, `duration_ms`.

### Database tables

| Table | Holds |
|---|---|
| `tasks` | status, prompt, result, error, timestamps, `session_id` |
| `task_events` | `MODEL_REQUEST`, `MODEL_RESPONSE` (with `rawUsage` verbatim from the provider), `TOOL_CALL`, `TOOL_RESULT`, `TASK_COMPLETED`, ... |
| `task_usage` | one row per task: tokens (total, uncached, cache read, cache write), latency, `est_cost_usd`, `priced_cost_usd`, `cost_status`, `cost_basis`, `pricing_ref` |
| `model_price_history` | append-only price snapshots (`input_per_m`, `cache_read_per_m`, `cache_write_per_m`, `output_per_m`, `raw_json`) |
| `price_pull_ledger` | one row per live price pull |

## Correlation: one id across logs and DB

`task_id` is the join key. It is a field in every task-scoped record of all three channels
(`task_id` in `api` and `ops`, `agent.task_id` in `trace`) and the primary key of `tasks` and
`task_usage`. `session_id` and `root_task_id` ride along on the same records.

```console
$ T=7e8f67d6-921d-40fc-b4b3-4ba94e10f105
$ rg -c "$T" ~/.adhd/agent-mcp/production/logs
.../logs/ops/agent-mcp.ops-2026-10-09.default.17080.jsonl:5
.../logs/trace/agent-mcp.live-service-2026-10-09.jsonl:4
.../logs/api/agent-mcp.api-2026-10-09.default.17080.jsonl:5
```

Within a channel, `call_id` pairs an outbound request with its response (`http.request` <->
`http.response`, `spawn.start` <-> `spawn.close`). For the inbound `tools/call` that started the
task, the `ops` records and the `api` `mcp.request`/`mcp.response` share one `call_id`
(`f36b62ca-...` in the first worked trace below). `trace_id` is only populated on the `trace`
channel, so use `task_id` to cross channels.

## Tailing and querying

### Follow the files

```bash
L=~/.adhd/agent-mcp/production/logs
tail -n 3 -F "$L"/ops/agent-mcp.ops-$(date -u +%F).default.*.jsonl | jq -c '{ts,event,agent,task_id,turn,stop_reason,input_tokens,output_tokens}'
```

Everything for one task, per channel (use `--no-filename`; `rg -h` prints help):

```console
$ rg --no-filename "$T" $L/ops | jq -c 'select(.event) | {ts,event,component,turn,stop_reason,input_tokens,output_tokens,duration_ms}'
{"ts":"2026-10-09T18:30:25.559Z","event":"task.start","component":"task","turn":null,...}
{"ts":"2026-10-09T18:30:26.476Z","event":"turn.start","component":"turn","turn":1,...}
{"ts":"2026-10-09T18:30:27.527Z","event":"turn.end","component":"turn","turn":1,"stop_reason":"completed","input_tokens":9994,"output_tokens":4,"duration_ms":1050}
{"ts":"2026-10-09T18:30:27.529Z","event":"task.completed","component":"task","turn":null,"input_tokens":9994,"output_tokens":4,"duration_ms":1969}

$ rg --no-filename "$T" $L/trace | jq -c '{ts,event,trace_id,span_id,parent_span_id,duration_ms}'
{"ts":"2026-10-09T18:30:25.560Z","event":"agent.task.start","trace_id":"01M4GYWH0R82ZSN19SH99M1FEX","span_id":"a4bbe8252bf87e96",...}
{"ts":"2026-10-09T18:30:27.528Z","event":"agent.model_call.finish",...,"duration_ms":1051}
{"ts":"2026-10-09T18:30:27.529Z","event":"agent.task.finish",...,"duration_ms":1969}

$ rg --no-filename "$T" $L/api | jq -c '{ts,event,call_id,method,url,status,tool,latency_ms}'
{"ts":"2026-10-09T18:30:26.479Z","event":"http.request","call_id":"6c69924f-...","method":"POST","url":"https://api.anthropic.com/v1/messages",...}
{"ts":"2026-10-09T18:30:27.526Z","event":"http.response","call_id":"6c69924f-...","status":200,"latency_ms":1047}
{"ts":"2026-10-09T18:30:27.589Z","event":"mcp.response","call_id":"f36b62ca-...","tool":"task",...}
```

Server lifecycle and pricing pulls:

```console
$ rg --no-filename '"component":"server"' $L/ops/agent-mcp.ops-2026-10-09.default.17080.jsonl | jq -c '{ts,event,pid,reason,signal,uptime_ms}'
{"ts":"2026-10-09T18:29:14.770Z","event":"server.listening","pid":17080,...}
{"ts":"2026-10-09T18:29:14.770Z","event":"server.start","pid":17080,...}
{"ts":"2026-10-09T18:34:13.734Z","event":"server.stop","pid":17080,"reason":"signal","signal":"SIGTERM","uptime_ms":299945}
{"ts":"2026-10-09T18:34:13.734Z","event":"server.shutdown","pid":17080,...,"uptime_ms":298967}

$ rg --no-filename '"event":"pricing\.' $L/ops/agent-mcp.ops-2026-10-09.default.13464.jsonl | jq -c '{ts,event,level,models,changed,anomalies,ledger_id}'
{"ts":"2026-10-09T18:28:00.692Z","event":"pricing.pull.start",...,"ledger_id":"446cc38f-a996-44d5-b4bf-998880e4375e"}
{"ts":"2026-10-09T18:28:00.893Z","event":"pricing.pull.end","level":"info","models":458,"changed":23,"anomalies":2,...}
```

### The task-event tail (`agent-mcp-tail`)

`src/scripts/agent-mcp-tail.ts` (bin `agent-mcp-tail`) reads the **database** (`task_events` joined
to `task_usage`), not the log files. It resolves the DB path through the same environment cascade
as the server, so with no overrides it reads production.

| Flag | Effect |
|---|---|
| `-a, --agent <name>` | only that agent |
| `-h, --include-history` | replay stored events instead of only new ones |
| `-n, --limit <n>` | last n |
| `-j, --json` | one JSON array of records (adds `taskUsage` on terminal events) |
| `-f, --full` | do not truncate payloads |
| `-F, --follow` | keep running, print new events |

```console
$ node entrypoint/agent-mcp/dist/src/scripts/agent-mcp-tail.js --agent live-trace-oauth --include-history
agent-mcp-tail -- /Users/nix/.adhd/agent-mcp/production/data/agents.db
  --agent: live-trace-oauth
  --include-history
  --mode: one-shot
10/09 - 2:36:34 PM live-trace-oauth   9f992132 MODEL_REQUEST                model=claude-haiku-4-5 messages=2 tools=31
10/09 - 2:36:34 PM live-trace-oauth   9f992132 MODEL_RESPONSE               completed Reply with exactly: ok
10/09 - 2:36:34 PM live-trace-oauth   9f992132 TASK_COMPLETED  Σ in=10.0K out=4 peak=10.0K ok
```

Two known quirks of this output are listed under [Known gaps](#known-gaps): the time column is the
wall clock at run time, and `MODEL_RESPONSE` shows the prompt text.

### Usage and cost over MCP (`usage_query`)

`usage_query` is the supported way to read `task_usage` through the server. Required arguments are
`include_incomplete`, `limit` and `grain` (`session`, `task` or `turn`); optional filters are
`task_id`, `root_task_id`, `agent_name`, `since`, `group_by` (`agent`, `model`, `provider`,
`response_model`). Drive it as an MCP client over HTTP (server started per
[dev-server-local-testing.md](./dev-server-local-testing.md)):

```js
// call.mjs <port> <tool> '<json args>'
import { createRequire } from 'node:module';
const req = createRequire('<repo>/entrypoint/agent-mcp/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const [port, name, args] = process.argv.slice(2);
const c = new Client({ name: 'doc-verify', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`)));
const r = await c.callTool({ name, arguments: JSON.parse(args ?? '{}') }, undefined, { timeout: 60000 });
console.log(r.content[0].text);
await c.close();
```

```console
$ node call.mjs 47851 usage_query '{"task_id":"8b711016-5275-4e7c-a3ad-c79b86c48fc5","grain":"task","limit":5,"include_incomplete":false}'
{ "grain": "task",
  "rows": [ { "task_id": "8b711016-...", "agent_name": "live-trace-claudecli", "provider_type": "claudecli",
              "model": "claude-haiku-4-5", "is_complete": true,
              "input_tokens": 4680, "output_tokens": 49, "uncached_input_tokens": 10,
              "cache_read_tokens": 0, "cache_creation_tokens": 4670, "model_calls": 1,
              "compute_ms": 32075, "total_ms": 34169, "est_cost_usd": 0.0060925,
              "cost_status": "priced", "cost_basis": "vendor-direct", "pricing_ref": "rate-card:claude_haiku_4_5", ... } ],
  "summary": { "row_count": 1, "priced_cost_usd": 0.0060925, "unpriced_tasks": 0, "price_age_hours": 0.147, ... } }

$ node call.mjs 47852 usage_query '{"agent_name":"live-trace-oauth","group_by":"response_model","grain":"task","limit":5,"include_incomplete":false}' | jq -c '.groups[] | {response_model: .key, taskCount, inputTokens, outputTokens, priced_cost_usd}'
{"response_model":"claude-haiku-4-5-20251001","taskCount":2,"inputTokens":19988,"outputTokens":8,"priced_cost_usd":0.020028}
```

Field semantics (`inputTokens` is cache-inclusive; `total_ms` is wall clock, `compute_ms` is model
time) are in [dev-server-local-testing.md, "Reading usage correctly"](./dev-server-local-testing.md#reading-usage-correctly).

### SQL against the store

Read-only queries are safe while a server runs (WAL). The DB is shared by every instance, so
filter by time or id:

```console
$ D=~/.adhd/agent-mcp/production/data/agents.db
$ sqlite3 -header -column $D "SELECT task_id, agent_name, provider_type, model, input_tokens, output_tokens, cache_read_input_tokens AS cache_read, cache_creation_input_tokens AS cache_write, est_cost_usd, cost_status, cost_basis, pricing_ref FROM task_usage WHERE task_id='$T'"
task_id                               agent_name        provider_type  model             input_tokens  output_tokens  cache_read  cache_write  est_cost_usd  cost_status  cost_basis     pricing_ref
7e8f67d6-921d-40fc-b4b3-4ba94e10f105  live-trace-oauth  anthropic      claude-haiku-4-5  9994          4              0           0            0.010014      priced       vendor-direct  rate-card:claude_haiku_4_5

$ sqlite3 -header -column $D "SELECT agent_name, model, count(*) AS tasks, sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok, round(sum(priced_cost_usd),6) AS usd FROM task_usage WHERE created_at >= '2026-10-09T18:29:00Z' GROUP BY agent_name, model"
agent_name            model             tasks  in_tok  out_tok  usd
live-trace-claudecli  claude-haiku-4-5  1      4680    49       0.006092
live-trace-oauth      claude-haiku-4-5  1      9994    4        0.010014

$ sqlite3 -header -column $D "SELECT type, substr(payload,1,90) AS payload, created_at FROM task_events WHERE task_id='$T' ORDER BY created_at"
type            payload                                                                                     created_at
MODEL_REQUEST   {"messageCount":2,"toolCount":31,"toolAdvertisement":"full"}                                2026-10-09T18:30:26.476Z
MODEL_RESPONSE  {"stopReason":"completed","hasContent":true,"toolCallCount":0,"responseModel":"claude-haik  2026-10-09T18:30:27.528Z
TASK_COMPLETED  {"result":"ok"}                                                                             2026-10-09T18:30:27.529Z
```

## Cost and pricing data

`task_usage` records tokens from the provider, then prices them:

- `cost_basis` says where the rate came from (`vendor-direct` = the in-code rate card for
  first-party models, `openrouter-estimate`, `owner-assumption`); `pricing_ref` points at it
  (`rate-card:<key>`, a `model_price_history` row id, or `bundled:<fetchedAt>:<id>`).
- `cost_status` is `priced`, or unpriced with `unpriced_tokens` counting what could not be priced.
- `model_price_history` is append-only (triggers abort `UPDATE`/`DELETE`). A daily pull appends
  rows; an anomalous move (for example a 20x price change) is held, not applied, and logged as
  `pricing.anomaly` until accepted with `pricing_refresh accept:[...]`.

Check a task's cost by hand: take the provider's own usage from the `api` log (or
`task_events.rawUsage`), multiply by the rate row, compare to `task_usage`:

```console
$ sqlite3 -header -column $D "SELECT model_id, observed_at, source, input_per_m, cache_read_per_m, cache_write_per_m, output_per_m FROM model_price_history WHERE model_id='anthropic/claude-haiku-4.5' ORDER BY observed_at DESC LIMIT 3"
model_id                    observed_at               source   input_per_m  cache_read_per_m  cache_write_per_m  output_per_m
anthropic/claude-haiku-4.5  2026-10-08T18:57:29.314Z  bundled  1.0          0.1               1.25               5.0

$ sqlite3 $D "SELECT (9994*1.0 + 0*0.1 + 4*5.0)/1e6"
0.010014
```

## Redaction guarantees

One redactor is shared by the `api` and `ops` channels (and the persisted pino lines):

1. At start the server collects the **values** of every environment variable whose name matches
   `SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH` (`collectKnownSecrets` in
   `src/wire/channels.ts`) and scrubs those values from every record, wherever they appear.
   Values that reach the process environment after the channels are created are not in that list; the scan below is the check.
2. Sensitive headers are replaced by a placeholder carrying a short hash and the length, for example
   `"authorization": "[REDACTED:f1ffb24f:len=26]"`; the hash lets you tell two different keys apart
   without revealing either.
3. URL query values are dropped (`redactUrl`); the names stay.
4. Redaction runs inside the channel at write time. No call site can bypass it, and a channel that
   cannot be opened degrades to inert (reported once on stderr) and logging never throws into the engine.

Verify it yourself (exit status `1` means no match anywhere in the production log tree):

```console
$ rg -c -i -P "sk-ant-[A-Za-z0-9_-]{8,}|bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]{8,}" ~/.adhd/agent-mcp/production/logs
$ echo "exit=$?"
exit=1
```

The live test runs the same scan (plus literal values of secret-named env vars) over every file the
run wrote, and first proves the scanner flags a planted `Bearer sk-ant-oat01-...`, so it cannot pass
by being blind.

Limits: redaction is value- and header-based. A secret a user pastes into a prompt, or a model
echoes back, is ordinary text and is logged as such in `api` bodies; turn the raw wire off
(`logging.api = off`) for a deployment that cannot tolerate that.

## Configuration knobs

All declared in `src/config.ts`; env names are `ADHD_AGENT_*`. Defaults need no setting.

| Setting | Env | Default | Effect |
|---|---|---|---|
| `logging.level` | `ADHD_AGENT_LOG_LEVEL` | `info` | pino application level (`trace`..`silent`) |
| `logging.dir` | `ADHD_AGENT_LOGGING_DIR` | unset = `~/.adhd/agent-mcp/<namespace>/logs` | relocates the whole log tree. Do not set it for production-store work |
| `logging.instanceLabel` | `ADHD_AGENT_LOGGING_INSTANCE_LABEL` | `default` | label in file names (`[A-Za-z0-9._-]{1,64}`) |
| `logging.api` | `ADHD_AGENT_LOGGING_API` | `on` | `off` stops only `api/` capture; `ops` and `trace` stay on and a `log.disabled` warning is logged at every start |
| `logging.apiBodyMaxBytes` | `ADHD_AGENT_LOGGING_API_BODY_MAX_BYTES` | 4194304 | per-body cap (sha256 of the full body is kept) |
| `logging.apiRotateBytes` / `apiRetentionDays` / `apiMaxDirBytes` | `..._API_ROTATE_BYTES` / `_API_RETENTION_DAYS` / `_API_MAX_DIR_BYTES` | 64 MiB / 14 / 2 GiB | rotation (gzip), age and total-size caps for `api/` |
| `logging.opsRotateBytes` / `opsRetentionDays` / `opsMaxDirBytes` | `..._OPS_ROTATE_BYTES` / `_OPS_RETENTION_DAYS` / `_OPS_MAX_DIR_BYTES` | 16 MiB / 60 / 256 MiB | same for `ops/` |
| `logging.traceRetentionDays` / `traceMaxDirBytes` | `..._TRACE_RETENTION_DAYS` / `_TRACE_MAX_DIR_BYTES` | 30 / 512 MiB | same for `trace/` |
| `logging.floodMaxBytes` / `floodWindowSeconds` | `..._FLOOD_MAX_BYTES` / `_FLOOD_WINDOW_SECONDS` | 256 MiB / 600 | flood breaker: past the byte cap inside the window, `api` drops to digest-only records |
| `tracing.service` / `logSink` / `logDir` | `ADHD_AGENT_TRACING_SERVICE` / `_LOG_SINK` / `_LOG_DIR` | `agent-mcp` / `file` / `<logs>/trace` | span sink (`file`, `stderr`, `none`) |
| `db.path` | `ADHD_AGENT_DATABASE_PATH` | unset = `~/.adhd/agent-mcp/production/data/agents.db` | relocates the DB (and the tail CLI) |

These are taken from the source declarations; the env-override paths were not exercised against
the production store, by design. Setting any of the four relocating variables (`DATABASE_PATH`,
`REGISTRY_DB_PATH`, `LOGGING_DIR`, `TRACING_LOG_DIR`) makes the live test refuse to run.

## Proving it live: the env-gated test

`src/__tests__/live/tracing-live.e2e.test.ts` (backlog `c536ce29` LIVE-AC1..AC5) starts the real
dev server on a free port with the production store, drives it as an MCP client, runs one
`Reply with exactly: ok` task on a `claudecli` agent and one on an Anthropic-OAuth agent
(`ADHD_AGENT_ANTHROPIC_SECRET`), then checks the DB and the three logs: both tasks completed, one
task id links `api`+`ops`+`trace`+DB, DB tokens and cost equal the wire usage times the
`model_price_history` rate (the arithmetic is in the assertions), no secret in any file written,
nothing written outside `~/.adhd/agent-mcp/production` and the repo `tmp/`.

It is gated by `AGENT_MCP_LIVE=1` because both providers are paid third-party services. Approved by
the repo owner (pseudosky); the same record is in the test header, `README.md` and `AGENTS.md`.
Each run costs under one US cent (about 15k tokens on claude-haiku-4-5) and leaves two task rows,
log lines and no agents behind (the test deletes the agents it creates).

Prerequisites (any missing one fails the run, it never skips):

```bash
npx nx run agent-mcp:build && npx nx run agent-mcp:dist-manifest   # built dist/
which claude                                                        # the claude CLI, logged in
# ADHD_AGENT_ANTHROPIC_SECRET set in ~/.adhd/.env (the server reads it; the test never does)
```

Run:

```console
$ cd entrypoint/agent-mcp
$ AGENT_MCP_LIVE=1 npx vitest run --config vitest.e2e.config.ts src/__tests__/live/tracing-live.e2e.test.ts
 RUN  v4.1.9 .../entrypoint/agent-mcp
 ✓ src/__tests__/live/tracing-live.e2e.test.ts (8 tests) 32331ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Starting a server on the production store applies any pending DB migrations and seeds/pulls
prices before it serves the first task; take a copy first if that matters:
`sqlite3 ~/.adhd/agent-mcp/production/data/agents.db ".backup <somewhere>/agents.db.bak"`.

## Worked traces

### 1. Anthropic API with a Claude OAuth token: one task, every layer

Agent: `{"type":"anthropic","model":"claude-haiku-4-5","env":{"secret":"ADHD_AGENT_ANTHROPIC_SECRET"}}`.
Task `7e8f67d6-921d-40fc-b4b3-4ba94e10f105`, reply `ok`.

1. **Inbound** (`api`): `mcp.response` for tool `task`, `call_id f36b62ca-...`, 2033 ms; the same
   `call_id` is on the `ops` records.
2. **Upstream request** (`api`, `http.request`, `call_id 6c69924f-...`): `POST https://api.anthropic.com/v1/messages`,
   headers `anthropic-beta: oauth-2025-04-20` (the OAuth token prefix selects this),
   `authorization: [REDACTED:f1ffb24f:len=26]`, 21625-byte body.
3. **Upstream response** (`api`, `http.response`): `status 200`, `ttfb_ms 1014`, `latency_ms 1047`,
   4 chunks. The streamed body ends with
   `message_delta ... usage {"input_tokens":9994,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4}`.
4. **Ops**: `task.start` (18:30:25.559) -> `turn.start` -> `turn.end {input_tokens:9994, output_tokens:4, response_model:"claude-haiku-4-5-20251001", compute_ms:1051}` -> `task.completed {duration_ms:1969}`.
5. **Trace**: `agent.task.start` ... `agent.model_call.finish {agent.model_call.input_tokens:9994, ...output_tokens:4}` ... `agent.task.finish {agent.outcome:"completed", duration_ms:1969}`, `trace_id 01M4GYWH0R82ZSN19SH99M1FEX`.
6. **DB**: `tasks.status = completed`; `task_usage` 9994 in / 4 out / 0 cache; `est_cost_usd = 0.010014`.
7. **Cost check**: 9994 x 1.0 + 0 x 0.1 + 4 x 5.0 = 10014 per-million-token units = 0.010014 USD,
   equal to `task_usage` and to the `model_price_history` row (1.0 / 0.1 / 1.25 / 5.0).

### 2. The `claude` CLI provider: a subprocess instead of an HTTP call

Agent: `{"type":"claudecli","model":"claude-haiku-4-5"}`. Task `8b711016-5275-4e7c-a3ad-c79b86c48fc5`,
reply `ok`, 34 s wall clock (CLI start-up and hooks dominate; `compute_ms 32075`).

- `api` lines (one `call_id`, `1c355814-...`): `spawn.start` (command `claude`, args
  `-p --dangerously-skip-permissions --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --mcp-config <production temp file> ...`),
  `spawn.stdin` (`{"type":"user","message":{"role":"user","content":"Reply with exactly: ok"}}`),
  six `spawn.stdout` lines (`system/hook_started`, `system/init`, two `assistant`, `rate_limit_event`,
  and the final `result` record), `spawn.exit` / `spawn.close` (`stdout_bytes 17213`, with sha256).
  The `result` record is the provider's own accounting:
  `usage {input_tokens:10, cache_creation_input_tokens:4670, cache_read_input_tokens:0, output_tokens:49, cache_creation:{ephemeral_1h_input_tokens:4670}}`, `total_cost_usd 0.009595`.
- `ops`: `task.start` (provider `claudecli`) -> `turn.end {input_tokens:4680, output_tokens:49, compute_ms:32075}` -> `task.completed {duration_ms:34163}`.
- `trace`: the same four `agent.*` spans.
- DB: `task_usage` 4680 in (10 uncached + 4670 cache write) / 49 out; `provider_type claudecli`.

The scratch files the CLI needs (mcp config, agent spec) are written under
`~/.adhd/agent-mcp/production/temp/`, not `os.tmpdir()` (the live test asserts no new
`agent-mcp-*` entries appear in `os.tmpdir()`).

### 3. Auditing a cost against the wire (and what it found)

Starting from `usage_query`/`task_usage` for trace 2, recompute the cost from the provider's own
usage and the price table:

| Component | Tokens | Rate per M (price table) | USD |
|---|---|---|---|
| uncached input | 10 | 1.00 | 0.000010 |
| cache write (5 minute) | 0 | 1.25 | 0 |
| cache write (1 hour) | 4670 | 2.00 (`input_cache_write_1h` = 0.000002 in `raw_json`) | 0.009340 |
| output | 49 | 5.00 | 0.000245 |
| **Total** | | | **0.009595** |

That equals the CLI's own `total_cost_usd` (0.009595). The stored `task_usage.priced_cost_usd` was
**0.0060925**: it prices all 4670 cache-write tokens at the 5-minute rate (4670 x 1.25), because the
rate card has one `cacheWritePerM` and no 1-hour tier. The difference, 0.0035025 USD (36.5% of the
vendor figure), appears only on a cold prompt cache, when the CLI writes the cache with a 1-hour TTL;
a warm re-run of the same task (cache read 4670 of 4680) priced exactly: 10 x 1.0 + 4670 x 0.1 +
37 x 5.0 = 662 units = 0.000662 USD. Tracked as backlog `b726a987`. The OAuth task in trace 1 has no
cache writes and is exact.

This is the general audit recipe: provider usage from `api`/`rawUsage` x rate row = expected cost;
compare to `task_usage`; compare to any vendor-reported total.

## Known gaps

Observed during the live verification above; each is filed in the backlog, none is fixed by this
guide.

- `b726a987`: cold-cache 1-hour cache writes are priced at the 5-minute rate (trace 3).
- `e9c485e1`: `agent-mcp-tail` one-shot history prints the wall-clock time of the run, not the
  event's `created_at`, and the `MODEL_RESPONSE` row shows the prompt text instead of the reply.
- `ddf26e2a`: `response_model` is null for `claudecli` tasks in `usage_query`; `agent.model_call.*`
  spans have `parent_span_id: null`; `trace_id` is null on `ops`/`api` records so `task_id` is the
  only cross-channel key; `pricing_ref` names the in-code rate card, not the `model_price_history`
  row, so the exact price row used cannot be joined from `task_usage`.
