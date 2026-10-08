# Local testing with the live-reload dev server

How to run a local `agent-mcp` over HTTP that reloads when `dist/` changes, and how an agent
(or a person) exercises it through the real MCP client path. Every command below was run
against a throwaway instance (port 47830, temp DBs, no production DB) unless marked
**not verified**.

- Architecture and security model: [architecture-and-security.md](./architecture-and-security.md)
- Native tooling decisions: [ADR-0008](../../../docs/decisions/0008-agent-mcp-native-tooling.md)
- Test lanes (unit vs e2e): [ADR-0009](../../../docs/decisions/0009-test-lanes-unit-vs-e2e.md)

## Rules

1. **Drive the real tools.** The default is a real-path test: call the running server's MCP
   tools the way a host does (JSON-RPC over HTTP). Do not import `dist/` and call functions,
   and do not substitute a mock for the thing under test (repo `AGENTS.md`, "Live testing is
   mandatory"). Only a paid or external third-party model is a legitimate reason for an env gate.
2. **e2e is not run locally.** The `e2e` lane is CI-only while the owner's pause holds
   (backlog `8963c3cb`). Locally run `npx nx affected -t lint,typecheck,typecheck-spec`,
   unit `test`, and this guide's live checks. See ADR-0009 for the lane split.
3. **Never point a throwaway at the production DB.** Give every throwaway its own
   `ADHD_AGENT_DATABASE_PATH` *and* `ADHD_AGENT_REGISTRY_DB_PATH` (see
   [Second instance](#running-a-second-instance)).
4. **Do not use the globally installed `agent-mcp-published` server for dev testing.** It runs
   published code, not your `dist/`.
5. Never pass `--skip-nx-cache`, never run `tsc` directly. Rebuild with the Nx targets below.

## Start, status, stop

```bash
# 1. Build dist. `build` alone does NOT emit dist/package.json; the server crashes without it
#    (backlog 91601303). dist-manifest adds it.
npx nx run agent-mcp:build
npx nx run agent-mcp:dist-manifest

# 2. Start the foreground supervisor (default port 47821).
npx nx run agent-mcp:serve

# 3. From another shell:
npx nx run agent-mcp:serve-status     # exit 0 running, 3 not running
npx nx run agent-mcp:serve-stop       # SIGTERM supervisor + server
```

Verified behaviour:

- The server binds `127.0.0.1:<port>` (`ADHD_AGENT_HOST`, default `127.0.0.1`); `lsof` shows
  `TCP 127.0.0.1:47830 (LISTEN)`. The SSE/gateway listener uses `ADHD_AGENT_SSE_PORT` /
  `ADHD_AGENT_SSE_HOST`.
- The port comes from `--port=N` or `AGENT_MCP_SERVE_PORT`. **`serve-status` and `serve-stop`
  read the same variable**: with `AGENT_MCP_SERVE_PORT` unset they look at 47821 and print
  `agent-mcp serve NOT running (port 47821)` even when another port is up.
- pid and log live under the checkout's own `tmp/agent-mcp/serve/serve-<port>.{pid,log}`, so
  a git worktree has its own pid/log directory.
- `serve-stop` prints `stopped supervisor pid=<n>`; the supervisor SIGTERMs the server and
  SIGKILLs it if it has not exited after 10 s.
- Nx serializes a task across processes: a second `nx run agent-mcp:serve` waits. Use
  `node entrypoint/agent-mcp/scripts/serve.mjs run --port=N` for report-and-exit behaviour.

## Reload on `dist/` change

The supervisor (`scripts/serve.mjs`) never builds. It fingerprints `dist/` (entry mtime/size,
newest mtime, file count) every `AGENT_MCP_SERVE_POLL_MS` (2000) and restarts the server once
the fingerprint has been stable for `AGENT_MCP_SERVE_STABLE_MS` (3000).

Rebuild with the project's Nx targets (cached; they change `dist/` only when inputs changed):

```bash
npx nx affected -t build        # or: npx nx run agent-mcp:build && npx nx run agent-mcp:dist-manifest
```

Observed log on a `dist` change (touching `dist/src/index.js` is enough to trigger it):

```text
[serve:47830] dist change detected; waiting for it to settle
[serve:47830] reload: SIGTERM server 93398
{"signal":"SIGTERM","msg":"Server shutdown"}
[serve:47830] child 93398 exited code=0 signal=null
[serve:47830] started server pid=4093 url=http://127.0.0.1:47830/ ...
```

Reload behaviours to plan around:

- **MCP sessions do not survive a reload.** A client holding the old `mcp-session-id` gets
  `HTTP 404` and must `initialize` again (verified). Stored data (agents, tasks, usage) lives in
  the SQLite DB and survives (`agent_list` after reload returned the same agent).
- **In-flight tasks can be dropped.** `SIGTERM` runs `shutdown()` in `src/index.ts`, which
  closes transports and calls `process.exit(0)` without draining the background queue. Tasks
  running at that moment are cut, and stay `running` in the DB (backlog `2353c2cc`, in
  progress; **not verified by running**). Do not rebuild while a task you care about is running.
- The supervisor's child `cwd` is the checkout root (verified with `lsof`), regardless of where
  you launched the supervisor. Details below.

## Configuration and isolation

All settings are declared in `src/config.ts`; env names are `ADHD_AGENT_*`. The supervisor sets
`ADHD_AGENT_TRANSPORT=http` and `ADHD_AGENT_PORT=<port>`, defaults `ADHD_AGENT_SSE_HOST` to
`127.0.0.1`, and passes every other variable through.

| Variable | Purpose |
|---|---|
| `ADHD_AGENT_DATABASE_PATH` | agents/tasks/usage SQLite DB. Unset: `~/.adhd/agent-mcp/production/data/agents.db` (the canonical DB) |
| `ADHD_AGENT_SKIP_LEGACY_MIGRATION=true` | A fresh DB is otherwise **seeded from the legacy `~/.adhd/agent-mcp/agents.db`**. Without the flag a new throwaway DB started with 69 copied agents (log: `migrate-legacy: copied flat legacy operational DB`); with it the log says `migrate-legacy: skipped (ADHD_AGENT_SKIP_LEGACY_MIGRATION)`. Set it for every new DB |
| `ADHD_AGENT_REGISTRY_DB_PATH` | Registry DB (providers/models/prompts). Verified: setting it moves the log line `Opening registry DB for compiler integration` to your path |
| `ADHD_AGENT_PORT` / `ADHD_AGENT_HOST` | MCP HTTP listener (set by the supervisor from `--port`) |
| `ADHD_AGENT_SSE_PORT` / `ADHD_AGENT_SSE_HOST` | SSE/gateway listener; if the port is taken it falls back to an OS-assigned port and logs `sse.listening` |
| `ADHD_AGENT_LOG_LEVEL` | `trace`..`silent` (default `info`) |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ALLOW_COMMANDS` | server-wide shell allowlist (see [Shell policy](#shell-policy)) |

**`ADHD_AGENT_DATABASE_PATH` does not redirect the registry DB.** A throwaway that sets only
`ADHD_AGENT_DATABASE_PATH` opens `~/.adhd/agent-registry/production/data/registry.db`
(backlog `243002e0`). Set `ADHD_AGENT_REGISTRY_DB_PATH` as well. Other files a throwaway still
touches outside its temp dir (observed in the startup log): `~/.srt-settings.json` and a per-run
`~/.adhd/agent-mcp/srt/run-<pid>.json` (sandbox policy), and it loads
`~/.adhd/agent-mcp/config.json` (global plugins, including the budget plugin).

### `.env` files and the launch directory

`loadEnvHierarchy` (`src/utils/load-env.ts`, commit `e34fb60f`) resolves, most specific first:
variables already in `process.env`, `<cwd>/.env`, `<cwd>/.adhd/.env`, `~/.adhd/.env`.
**Process environment beats every `.env` file**, so an explicit `ADHD_AGENT_DATABASE_PATH` on
the launch command cannot be redirected by a repo `.env` (which in this repo sets
`ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`). Provider secrets
(`ADHD_AGENT_<PROVIDER>_SECRET`) are read by the server itself from `~/.adhd/.env`; you do not
forward them.

`scripts/serve.mjs` always starts the server with `cwd` = the checkout root, which can contain
a `.env`. Therefore: always set the DB variables explicitly in the launch environment. If you
need the server's `cwd` to be an **empty** directory (no repo `.env` at all), run your own
supervisor with a different child cwd; `tmp/agent-mcp-live/devserver-sox/launch.sh` plus its
`supervisor.mjs` (`SUP_DIST`, `SUP_CWD`, `SUP_LOG`, `SUP_PID`) is a worked example of that
pattern (**not verified by this guide's run**, which used `serve.mjs`).

### Running a second instance

```bash
export V=$PWD/tmp/agent-mcp-live/my-run && mkdir -p $V
ADHD_AGENT_DATABASE_PATH=$V/agents.db \
ADHD_AGENT_REGISTRY_DB_PATH=$V/registry.db \
ADHD_AGENT_SKIP_LEGACY_MIGRATION=true \
ADHD_AGENT_SSE_PORT=47831 \
AGENT_MCP_SERVE_PORT=47830 \
  node entrypoint/agent-mcp/scripts/serve.mjs run          # foreground; background it yourself
AGENT_MCP_SERVE_PORT=47830 npx nx run agent-mcp:serve-stop  # stop THIS instance
```

Verified startup lines: `registryDbPath` is under `$V`, `migrate-legacy: skipped`, and
`"transport":"http","host":"127.0.0.1","port":47830,"msg":"MCP server started"`. Each port has
its own pid/log pair, so instances do not collide. A second instance that should carry only
selected agents (for example a catalog created by `soxe reconcile-agent-mcp`) needs its own DB
path: `soxe reconcile-agent-mcp` starts its own stdio agent-mcp against the DB path it is given,
so even `--dry-run` creates that DB file and its schema.

## Calling the server like a host

The transport is streamable HTTP: `POST /` with JSON-RPC, `Accept: application/json,
text/event-stream`. Responses arrive as `event: message` / `data: {...}` frames. One
`initialize` opens one session (`mcp-session-id` response header); many sessions can be open at
once. The 20 tools: `agent_create agent_read agent_update agent_delete agent_list
agent_verify_mcp agent session_list session_close session_update session_clear task
tasks_batch task_list task_cancel task_resume result usage_query guide`.

Raw protocol (verified):

```bash
U=http://127.0.0.1:47830/
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
curl -sS -D hdr.txt -o /dev/null "${H[@]}" $U -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
SID=$(rg -i '^mcp-session-id:' hdr.txt | awk '{print $2}' | tr -d '\r')
curl -sS -o /dev/null "${H[@]}" -H "mcp-session-id: $SID" $U -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'   # 202
curl -sS "${H[@]}" -H "mcp-session-id: $SID" $U -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The initialize reply was `{"serverInfo":{"name":"agent-mcp","version":"2.3.6"},"protocolVersion":"2025-03-26",...}`.

Easier, with the repo's SDK client (resolve `@modelcontextprotocol/sdk` from this package):

```js
import { createRequire } from 'node:module';
const req = createRequire('<repo>/entrypoint/agent-mcp/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const c = new Client({ name: 'local-test', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:47830/')));
const r = await c.callTool({ name: 'task', arguments: { agent_name: 'docs-ok', prompt: '...' } }, undefined, { timeout: 300000 });
console.log(r.content[0].text);
await c.close();
```

### Worked example: the single-word `ok` task (no tools)

1. Create a disposable agent. `provider.env` holds **names** of env vars the server resolves
   (only `ADHD_AGENT_*` names are allowed); `mcpServers: {}` adds no extra servers:

   `agent_create` ←
   `{"name":"docs-ok","systemPrompt":"You reply tersely.","provider":{"type":"openai","env":{"secret":"ADHD_AGENT_DEEPSEEK_SECRET","base_url":"ADHD_AGENT_DEEPSEEK_BASE_URL","model":"ADHD_AGENT_DEEPSEEK_MODEL"}},"mcpServers":{},"permissions":{}}`

2. Run it (`task` with `agent_name` is a one-shot, synchronous, ephemeral task):

   `task` ← `{"agent_name":"docs-ok","prompt":"Reply with exactly the single word: ok. Do not use any tools."}`

   Captured reply:

   ```json
   {"task_id":"f06d0947-b663-4732-a4da-6363972ac803","status":"completed","result":"ok",
    "usage":{"direct":{"inputTokens":6258,"outputTokens":22,"modelCalls":1,"toolCallCount":0,
      "latencyMs":2287,"stopReason":"stop","uncachedInputTokens":6258,"cacheReadTokens":0,
      "cacheCreationTokens":0,"reasoningTokens":20,"peakContextTokens":6258},"subtree":{...},"taskCount":1}}
   ```

3. Inspect with the other tools (all verified):

   | Tool | Call | Result |
   |---|---|---|
   | `result` | `{"task_id":"<id>"}` | task row: `status`, `prompt`, `result`, timestamps, `usage` |
   | `task_list` | `{"agent_name":"docs-ok","summary":true,"limit":5}` | rows without prompt/result text |
   | `usage_query` | `{"agent_name":"docs-ok","grain":"task","limit":5,"include_incomplete":false}` | per-task usage rows + `summary` |
   | `agent_list` / `agent_read` | `{}` / `{"name":"docs-ok"}` | stored definitions (`agent_read` omits `systemPrompt` unless `fullDefinition:true`) |
   | `task_cancel` | `{"task_id":"<id>"}` | on a finished task: `[TASK_NOT_CANCELLABLE] ... has status 'completed'`; use it on a `running`/`pending` id |

   Use `task` with `background:true` plus `result` to poll long runs.

### Reading usage correctly

| Field | Meaning (verified against the run above and source) |
|---|---|
| `inputTokens` | Total prompt tokens, **cache-inclusive** (`uncachedInputTokens + cacheReadTokens`). 6258 = 242 + 6016 on a warm repeat of the same call |
| `latencyMs` / `total_ms` | **Whole-task wall-clock** from task start to terminal, including MCP server startup. Not model time |
| `compute_ms` (usage_query) | Model-call time only (1063 ms for the call above vs 2287 ms total) |
| `est_cost_usd` | `null` while `model` is recorded as `default` (it was, for this env-ref agent). Cost cannot be read from this field yet |
| budget plugin | counts cache reads at **full weight** toward `inputTokens` limits, so a 500k/24h cap can trip in a handful of cached calls and surface as a tool error |
| first call vs repeat | the first call has no cache hit (`uncached` = all), later identical prefixes are mostly `cacheReadTokens` |

Cross-tool comparisons (for example against opencode) must normalise: other tools report
`input` excluding cache reads.

### What an agent actually advertises

- Every agent gets the default `nativeTooling` servers even with `mcpServers: {}`.
  `agent_verify_mcp {"name":"docs-ok"}` (connects each server, no model call) returned `fs`
  (14 tools), `shell` (`shell_execute`) and `agent-mcp` (skipped, self-referential, handled
  in-process). A real agent with many configured servers advertised **112 tools** (`MODEL_REQUEST`
  event `toolCount`), about 67k input tokens for a no-tool prompt.
- `toolAdvertisement` on the agent definition: `full` (default in code,
  `orchestrator.ts` `?? 'full'`; the `claudecli` provider is always `full`) sends complete JSON
  Schemas; `names` sends a compact name doc instead. Measured on the same no-tool prompt:
  `full` 6258 input tokens, `names` 4560.
- Per MCP server in `mcpServers`, `allowedTools` (only these) and `disallowedTools` (hidden and
  rejected at call time) filter what the model sees (`agent-engine-orchestrator`
  `clients/registry.ts` `isToolHidden`).

### Shell policy

The shell member is `tumf/mcp-shell-server` behind `srt` (ADR-0008 D5/D7). The server, not the
harness, decides what may run, and it matches **only `argv[0]`** (an exact name in
`allowCommands`, or a `re.fullmatch` of `allowPatterns`); arguments are never allowlisted. A
`shell: true` with no `allowCommands` allows nothing.

Set the allowlist per agent (`nativeTooling.shell.allowCommands`, plus `timeoutMs`) or
server-wide with `ADHD_AGENT_NATIVE_TOOLING_SHELL_ALLOW_COMMANDS` (csv). The sox renderer
assigns tiered lists (read-only, implementer, git-merge, backlog-ops, orchestrator). Git and
deletion go through wrapper commands from sox-ecosystem `libs/agent-shell-wrappers`:
`sox-git-ro`, `sox-git-impl`, `sox-git-merge`, `sox-rm`. Plain `git` and `rm` are in no list.

Wrapper installation requirement: the four names must resolve **on the dev server process's
`PATH`**, as symlinks named exactly `sox-git-ro`, `sox-git-impl`, `sox-git-merge` (all pointing
at `bin/sox-git`; the script selects its mode from `basename(argv[0])`) and `sox-rm` (pointing
at `bin/sox-rm`). The sox-only dev server's `devserver-sox/bin` holds those symlinks and its
`launch.sh` prepends that directory to `PATH` and checks each name with `command -v` before
starting. Shell-server limits that still apply to allowlisted names: no `sh bash python node
env sed sqlite3 xargs ...`, no `;`, `&&`, redirects or env prefixes; a literal `|` token is
validated per segment.

Not verified by this guide's run: wrapper behaviour and the per-agent allowlists (the throwaway
had no wrappers on `PATH`). Source of record: the shell-policy spec in the run's handoff notes
and the sox install report; enforcement is checked there, not here.

## Checklist for an agent testing a change

1. `npx nx run agent-mcp:build && npx nx run agent-mcp:dist-manifest`.
2. Start a throwaway with its own DB, registry DB, `ADHD_AGENT_SKIP_LEGACY_MIGRATION=true`, and a
   non-default port. Confirm the three startup lines above.
3. `initialize`, then drive the tool you changed through the real client; assert on the returned
   payload and exit status, not on logs.
4. Rebuild; wait for `reload: SIGTERM server`; re-`initialize` (old session id is 404).
5. `serve-stop` with the same `AGENT_MCP_SERVE_PORT`; confirm `lsof -iTCP:<port>` is empty.
6. Leave the working tree as you found it (`git status --porcelain`); scratch lives under `tmp/`.
