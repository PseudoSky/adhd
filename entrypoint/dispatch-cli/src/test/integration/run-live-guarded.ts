#!/usr/bin/env node
/**
 * run-live-guarded.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE ONLY — self-executing script gated behind `DISPATCH_E2E_LIVE=1`.
 * Never collected by Vitest (`vite.config.ts` includes only `*.{test,spec}.*`),
 * never run by `nx affected -t test`. Exits 0 with a loud notice when NOT gated.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * APPROVED GATE (AGENTS.md §7 — a real model is a paid/external third-party
 * service, the single permitted gate reason):
 *   - Owner: pseudosky (repo owner, skywinstonsk@gmail.com).
 *   - Recorded in all three required places: this header,
 *     `entrypoint/dispatch-cli/README.md` ("Guarded live runner — run-live-guarded.ts"),
 *     and `entrypoint/dispatch-cli/AGENTS.md`.
 *   - FAILS LOUDLY when enabled but a required credential / built artifact /
 *     telemetry source is absent — never a silent skip.
 *
 * WHAT THIS IS
 * A GUARDED runner that wraps a real dispatch-through-a-real-agent-mcp run with
 * hard, mechanical guards so a live test can NEVER run away — the missing
 * safety layer behind the `live-dispatch-five-acs.e2e.test.ts` suite. It is the
 * harness a later, separately-authorized live test will drive; it is NOT that
 * test (NAT-TOOL-3/8 were still building when this landed).
 *
 * It reuses the real substrate (never reimplements it):
 *   - real `DagClient`/serializer → real `orchestrateCycle` → real `AgentMcpRunner`
 *     → a real spawned `@adhd/agent-mcp` (stdio JSON-RPC, real stores/engine)
 *     → a real provider (DeepSeek by default; `anthropic`; or `claudecli`).
 *   - the same minimal DAG/milestone helpers the live five-AC suite uses.
 *   - the child's real SQLite store (`task_usage`, `messages`, `task_events`,
 *     `tasks`) as the telemetry source — `usage_query`'s own backing tables.
 *
 * THE GUARDS (all hard-fail; none is advisory)
 *   1. STRICT TURN COUNT. `DISPATCH_E2E_MAX_TURNS` (default 12) is applied twice:
 *      as `maxToolLoops` on every agent definition (per-agent tool-loop /
 *      delegation cap — `engine/policy.ts`) and as `ADHD_AGENT_BUDGET_MAX_CALLS`
 *      on the child (agent-mcp's default budget plugin, a GLOBAL model-call cap,
 *      `config.ts#defaultPluginEntries`). After the run the measured
 *      `SUM(task_usage.model_calls)` must be `<= MAX_TURNS`.
 *   2. CONTINUOUS COST MONITOR + KILL. Every `DISPATCH_E2E_POLL_MS` (default
 *      1000) the monitor reads cumulative `SUM(task_usage.est_cost_usd)`. If it
 *      exceeds `DISPATCH_E2E_MAX_COST_USD` (default 0.10 — the DeepSeek ceiling),
 *      the run is HARD-KILLED: the spawned agent-mcp is closed, the orchestration
 *      is aborted, and the process exits non-zero with the cost evidence.
 *      If any task's cost is `NULL` while it made model calls (the model has no
 *      rate-card entry, so `est_cost_usd` can never be computed) and no proxy is
 *      configured to meter at a lower layer, the run FAILS LOUDLY rather than
 *      continue unmetered.
 *   3. MESSAGE-SIZE PROTECTION. Every poll reads the largest single stored
 *      message byte-length across `messages.content/tool_calls/tool_results`,
 *      `tasks.prompt/result`, and `task_events.payload`. Exceeding
 *      `DISPATCH_E2E_MAX_MSG_BYTES` (default 262144 = 256 KiB) kills the run.
 *   4. PROXY OPTION. When `DISPATCH_E2E_PROXY` is set, the provider `base_url`
 *      and the child's `HTTP(S)_PROXY` env route every API call through it, so a
 *      proxy can meter/block. When unset, the runner says so and relies on (2)/(3).
 *   5. DELEGATION ASSERTION. The `delegation` scenario drives a dispatched agent
 *      that really uses the agent-dispatching tools: the parent is created with
 *      the self-referential `agent-mcp` MCP server and `allowedAgents:[child]`,
 *      and is asked to call `agent-mcp__agent {"name": <child>}`. Success is
 *      asserted by a real child SESSION row existing (only the dispatching tool
 *      can create it). Requires a function-tool provider; loud SKIP under
 *      `claudecli`.
 *
 * RUN (from the repo root; a real, billed model call — costs money):
 *   npx nx run agent-mcp:dist-manifest   # prerequisite: build the child server
 *   set -a; source ~/.adhd/.env; set +a  # ADHD_AGENT_DEEPSEEK_SECRET etc.
 *   DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json \
 *     entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
 *
 * Prove the KILL fires (tiny cap => breaches on the first priced turn):
 *   DISPATCH_E2E_LIVE=1 DISPATCH_E2E_MAX_COST_USD=0.000001 DISPATCH_E2E_POLL_MS=100 \
 *   DISPATCH_E2E_SCENARIO=delegation npx tsx --tsconfig tsconfig.base.json \
 *     entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts
 *   # exits non-zero, prints [GUARD-KILL:cost-exceeded] with the observed cost.
 *
 * WHY THIS FILE IS NOT TYPECHECKED by an Nx target (mirrors `real-e2e.ts`):
 * `tsconfig.lib.json` excludes `src/test/**` and `tsconfig.spec.json` includes
 * only `*.{test,spec}.*`, so a `src/test/**` non-spec script is outside both the
 * build and the typecheck-spec ratchet. Verification is the tsx invocation above
 * (the real consumer entrypoint). NOTE — `real-e2e.ts` in this same directory
 * computes its `REPO_ROOT` with one `..` too many and its CLI path still points
 * at the pre-migration `packages/dispatch/dispatch-cli`; this file deliberately
 * does NOT copy that bug (it resolves the repo root with five `..`, matching
 * `src/test/helpers/agent-mcp-registry.ts`). See backlog DEBT for that file.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import Database from 'better-sqlite3';

import type {
  DagJson,
  MilestoneDag,
  OperationDag,
  PartialBinding,
} from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { optimize, snapshot } from '@adhd/dispatch-core-optimizer';
import {
  AgentMcpRunner,
  DEFAULT_B_PER_TIER,
  DEFAULT_CONTEXT_WINDOW_PER_TIER,
  orchestrateCycle,
  type OrchestratorDeps,
} from '@adhd/dispatch-orchestrator';

import { resolveDispatchMcpServers } from '../../lib/core.js';

import {
  GuardAbort,
  RunMonitor,
  enforcePostRun,
  readUsageSnapshot,
  type GuardConfig,
  type UsageSnapshot,
} from './live-guard-core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Paths. Resolved locally (NOT via `helpers/agent-mcp-registry.ts`) because that
// helper derives its root from `import.meta.url`, which throws under the
// documented `tsx --tsconfig tsconfig.base.json` (CommonJS) invocation. Five `..`
// from `src/test/integration/` is the repo root — the same depth the helper
// uses from `src/test/helpers/`. (`real-e2e.ts` in this directory uses six and
// is wrong; see the header.)
// ─────────────────────────────────────────────────────────────────────────────

// `__dirname` is the CommonJS global (the documented invocation is
// `tsx --tsconfig tsconfig.base.json`, which runs this file as CJS). Declared so
// the file is self-describing; it has no runtime effect.
declare const __dirname: string;
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const AGENT_MCP_DIST = join(REPO_ROOT, 'entrypoint', 'agent-mcp', 'dist', 'src', 'index.js');
const AGENT_MCP_DIST_PKG_JSON = join(REPO_ROOT, 'entrypoint', 'agent-mcp', 'dist', 'package.json');
const MEMORY_STUB = join(
  REPO_ROOT,
  'entrypoint',
  'dispatch-cli',
  'src',
  'test',
  'fixtures',
  'memory-stub-server.mjs'
);
const TMP_ROOT = join(REPO_ROOT, 'tmp', 'dispatch-cli', 'live-guarded');

// ─────────────────────────────────────────────────────────────────────────────
// Config surface (every knob is env-overridable; defaults are the guardrails).
// ─────────────────────────────────────────────────────────────────────────────

type ProviderKind = 'claudecli' | 'deepseek' | 'anthropic';

const LIVE = process.env['DISPATCH_E2E_LIVE'] === '1';
const PROVIDER = (process.env['DISPATCH_E2E_PROVIDER'] ?? 'deepseek') as ProviderKind;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`run-live-guarded: ${name}='${raw}' is not a number`);
  }
  return Math.trunc(n);
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`run-live-guarded: ${name}='${raw}' is not a number`);
  }
  return n;
}

/** Per-provider model with a RATE_CARD entry, so `est_cost_usd` is computable. */
function defaultModel(provider: ProviderKind): string {
  if (provider === 'deepseek') return 'deepseek-v4-flash'; // rate-card key exists
  if (provider === 'anthropic') return 'claude-haiku-4-5'; // normalizes to claude_haiku_4_5
  return ''; // claudecli chooses the model itself
}

const MODEL = process.env['DISPATCH_E2E_MODEL'] ?? defaultModel(PROVIDER);
const MAX_TURNS = intEnv('DISPATCH_E2E_MAX_TURNS', 12);
const MAX_COST_USD = floatEnv('DISPATCH_E2E_MAX_COST_USD', 0.1);
const MAX_MSG_BYTES = intEnv('DISPATCH_E2E_MAX_MSG_BYTES', 262144);
/** Bounded poll interval; floored so a misconfiguration cannot busy-loop. */
const POLL_MS = Math.max(100, intEnv('DISPATCH_E2E_POLL_MS', 1000));
const PROXY = (process.env['DISPATCH_E2E_PROXY'] ?? '').trim() || undefined;
const SCENARIO = (process.env['DISPATCH_E2E_SCENARIO'] ?? 'all') as
  | 'all'
  | 'dispatch'
  | 'delegation'
  | 'native-fs-shell'
  | 'portability'
  | 'hitl'
  | 'retention';

/** A model provider that advertises JSON-schema tools (agent-mcp's client-side
 *  pseudo-tools, e.g. `agent-mcp__agent`, are only reachable from one). */
const FUNCTION_TOOL_PROVIDER = PROVIDER !== 'claudecli';

const RUN_COMMAND =
  'DISPATCH_E2E_LIVE=1 npx tsx --tsconfig tsconfig.base.json ' +
  'entrypoint/dispatch-cli/src/test/integration/run-live-guarded.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Guard primitives live in `./live-guard-core.ts` (side-effect-free, and covered
// by a default-running spec: `live-guard-core.spec.ts`). Imported at the top of
// this file: GuardAbort, RunMonitor, enforcePostRun, GuardConfig, UsageSnapshot.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Prerequisite probes — FAIL LOUDLY, never skip silently.
// ─────────────────────────────────────────────────────────────────────────────

function assertPrerequisites(): void {
  if (!existsSync(AGENT_MCP_DIST)) {
    throw new Error(
      `run-live-guarded: built agent-mcp entry missing at ${AGENT_MCP_DIST} — ` +
        'run `npx nx run agent-mcp:dist-manifest` first.'
    );
  }
  // The child `server.js` requires `../package.json`, emitted by dist-manifest.
  if (!existsSync(AGENT_MCP_DIST_PKG_JSON)) {
    throw new Error(
      `run-live-guarded: ${AGENT_MCP_DIST_PKG_JSON} missing — run ` +
        '`npx nx run agent-mcp:dist-manifest` first.'
    );
  }
  if (!existsSync(MEMORY_STUB)) {
    throw new Error(`run-live-guarded: memory stub fixture missing at ${MEMORY_STUB}`);
  }
  if (PROVIDER === 'deepseek' || PROVIDER === 'anthropic') {
    const secretName =
      PROVIDER === 'deepseek' ? 'ADHD_AGENT_DEEPSEEK_SECRET' : 'ADHD_AGENT_ANTHROPIC_SECRET';
    if (!process.env[secretName]) {
      throw new Error(
        `run-live-guarded: DISPATCH_E2E_PROVIDER=${PROVIDER} but ${secretName} is unset. ` +
          'Refusing to skip silently. Source ~/.adhd/.env (the repo convention) or set it. ' +
          `Run: ${RUN_COMMAND}`
      );
    }
    if (!MODEL) {
      throw new Error(`run-live-guarded: a model is required for provider ${PROVIDER}`);
    }
    return;
  }
  // claudecli: require an authenticated local `claude` CLI.
  try {
    const status = execFileSync('claude', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const parsed = JSON.parse(status) as { loggedIn?: boolean };
    if (parsed.loggedIn !== true) {
      throw new Error(`claude auth status reports loggedIn=${String(parsed.loggedIn)}`);
    }
  } catch (err) {
    throw new Error(
      'run-live-guarded: claudecli selected but `claude auth status` did not confirm a login ' +
        `(${err instanceof Error ? err.message : String(err)}).`
    );
  }
  if (!PROXY) {
    console.warn(
      '[run-live-guarded] provider=claudecli with no DISPATCH_E2E_PROXY: agent-mcp records no ' +
        'reliable model string, so est_cost_usd will be NULL and the cost monitor will FAIL LOUDLY ' +
        '(cost-telemetry-unavailable) on the first priced turn. Use deepseek/anthropic for a ' +
        'cost-metered run, or configure a proxy to meter spend.'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner launch (hermetic child; mirrors live-dispatch-five-acs.e2e.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface Launched {
  runner: AgentMcpRunner;
  scratch: string;
  /** The fake `$HOME` the spawned child ran with (D11 #14 leak guard). */
  home: string;
  dagPath: string;
  dbPath: string;
}

/** Options for {@link launch} beyond the scenario defaults. */
interface LaunchOptions {
  /** Reuse an existing scratch dir (the portability scenario shares one store). */
  scratch?: string;
  /** Reuse an existing fake HOME. */
  home?: string;
  /** Reuse an existing child store path (so two children share one registry DB). */
  dbPath?: string;
  /** The spawned child's cwd (the "dispatching cwd", ADR-0008 D4). Default: the scratch dir. */
  cwd?: string;
  /** The explicit `mcpServers` the child's `agent_create` gets (dispatch-host path). */
  defaultMcpServers?: Record<string, Record<string, unknown>>;
  /** Declarative native toolset stored on create, resolved at task time (ADR-0008 D3/D4). */
  nativeTooling?: Record<string, unknown>;
  /** Create a DAG-named agent if absent. Default false (mirrors the dispatch host). */
  createAgentsIfMissing?: boolean;
  /** Extra child env merged over the hermetic defaults. */
  extraEnv?: Record<string, string>;
}

/**
 * Create the isolated fake `$HOME` for a spawned agent-mcp (D11 #14: the
 * `.env override:true` leak guard). Pre-creates the cache roots the `srt`-wrapped
 * `npx`/`uvx` servers initialize, so `provisionSrtPolicy`'s existing-dir filter
 * (`defaultSrtAllowWrite`) picks them up even though `$HOME` is not the real one.
 */
function mkFakeHome(scratch: string): string {
  const home = join(scratch, 'home');
  for (const rel of ['.cache/uv', '.npm', '.local/share/uv', '.adhd']) {
    mkdirSync(join(home, rel), { recursive: true });
  }
  return home;
}

/**
 * Build the child env: strip every ambient `ADHD_AGENT_*` (so the real
 * `~/.adhd` store is never touched), then apply explicit overrides. The
 * provider secret is re-added from the parent for the selected provider.
 * `HOME`/`PATH` are preserved (claudecli OAuth is home-bound).
 */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ADHD_AGENT_')) continue;
    if (v !== undefined) env[k] = v;
  }
  const merged: Record<string, string> = { ...env, ...overrides };
  if (PROXY) {
    merged['HTTP_PROXY'] = PROXY;
    merged['HTTPS_PROXY'] = PROXY;
    merged['http_proxy'] = PROXY;
    merged['https_proxy'] = PROXY;
  }
  if (PROVIDER === 'deepseek') {
    merged['ADHD_AGENT_DEEPSEEK_SECRET'] = process.env['ADHD_AGENT_DEEPSEEK_SECRET'] ?? '';
  }
  if (PROVIDER === 'anthropic') {
    merged['ADHD_AGENT_ANTHROPIC_SECRET'] = process.env['ADHD_AGENT_ANTHROPIC_SECRET'] ?? '';
  }
  return merged;
}

/** Spawn a real agent-mcp for one scenario, in an isolated scratch dir + fake HOME. */
function launch(scenario: string, opts: LaunchOptions = {}): Launched {
  const scratch = opts.scratch ?? mkdtempSync(join(TMP_ROOT, `${scenario}-`));
  const dbPath = opts.dbPath ?? join(scratch, 'agents.db');
  const home = opts.home ?? mkFakeHome(scratch);
  const runner = new AgentMcpRunner({
    command: process.execPath,
    args: [AGENT_MCP_DIST],
    // The dispatching cwd (D4): rooting the child here makes its task-time
    // native resolution root fs/shell at this directory.
    cwd: opts.cwd ?? scratch,
    env: childEnv({
      // D11 #14: fake HOME, so `~/.adhd/.env` (the real user's) is never read and
      // the srt policy is written under the scratch home, not the real one.
      HOME: home,
      ADHD_AGENT_DATABASE_PATH: dbPath,
      ADHD_AGENT_REGISTRY_DB_PATH: join(scratch, 'registry.db'),
      ADHD_AGENT_SSE_ENABLED: 'false',
      ADHD_AGENT_TRANSPORT: 'stdio',
      // Hermetic: point the config loader at a path that does not exist so the
      // developer's real ~/.adhd/agent-mcp/config.json can never replace the
      // env-driven budget cap.
      ADHD_AGENT_CONFIG: join(scratch, 'no-agent-mcp-config.json'),
      ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true',
      // GUARD 1: agent-mcp's default budget plugin enforces this as a GLOBAL
      // cumulative model-call cap (config.ts#defaultPluginEntries).
      ADHD_AGENT_BUDGET_MAX_CALLS: String(MAX_TURNS),
      ...(opts.extraEnv ?? {}),
    }),
    ...(opts.defaultMcpServers
      ? { defaultMcpServers: opts.defaultMcpServers }
      : {}),
    ...(opts.nativeTooling !== undefined
      ? { nativeTooling: opts.nativeTooling }
      : {}),
    ...(opts.createAgentsIfMissing !== undefined
      ? { createAgentsIfMissing: opts.createAgentsIfMissing }
      : {}),
    // Pair the MCP request budget with the poll budget so a long synchronous
    // task call is never aborted at the SDK's 60s default.
    requestTimeoutMs: 300_000,
  });
  return { runner, scratch, home, dagPath: join(scratch, 'dag.json'), dbPath };
}

async function closeRunner(runner: AgentMcpRunner): Promise<void> {
  try {
    await runner.close();
  } catch {
    /* best effort */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider + agent provisioning
// ─────────────────────────────────────────────────────────────────────────────

/** `DispatchUnit.provider` shape (snake_case). `base_url` routes via the proxy. */
function providerConfig(): PartialBinding {
  if (PROVIDER === 'deepseek') {
    return {
      providerType: 'openai',
      modelRef: MODEL,
      env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
      baseURL: PROXY ?? 'https://api.deepseek.com/v1',
      timeoutMs: 180_000,
      retryConfig: { retries: 0, minTimeout: 1000, maxTimeout: 5000, factor: 2 },
    };
  }
  if (PROVIDER === 'anthropic') {
    return {
      providerType: 'anthropic',
      modelRef: MODEL,
      env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
      baseURL: PROXY ?? null,
      timeoutMs: 180_000,
      retryConfig: { retries: 0, minTimeout: 1000, maxTimeout: 5000, factor: 2 },
    };
  }
  return {
    providerType: 'claudecli',
    modelRef: MODEL,
    baseURL: PROXY ?? null,
    timeoutMs: 240_000,
    retryConfig: { retries: 0, minTimeout: 1000, maxTimeout: 5000, factor: 2 },
  };
}

/** The camelCase `agent_create.provider` payload agent-mcp accepts. */
function agentProviderPayload(): Record<string, unknown> {
  if (PROVIDER === 'deepseek') {
    return {
      type: 'openai',
      model: MODEL,
      baseURL: PROXY ?? 'https://api.deepseek.com/v1',
      env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
      timeoutMs: 180_000,
    };
  }
  if (PROVIDER === 'anthropic') {
    const payload: Record<string, unknown> = {
      type: 'anthropic',
      model: MODEL,
      env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
      timeoutMs: 180_000,
    };
    if (PROXY) payload['baseURL'] = PROXY;
    return payload;
  }
  const payload: Record<string, unknown> = { type: 'claudecli', timeoutMs: 240_000 };
  if (MODEL) payload['model'] = MODEL;
  if (PROXY) payload['baseURL'] = PROXY;
  return payload;
}

interface CreateAgentOptions {
  systemPrompt?: string;
  permissions?: Record<string, unknown>;
  mcpServers?: Record<string, Record<string, unknown>>;
  allowHumanInput?: boolean;
  /** Declarative native tooling (ADR-0008 D1/D3) — resolved at task time. */
  nativeTooling?: Record<string, unknown>;
}

/** Create a real agent-mcp agent with the run's turn cap baked in. */
async function createAgent(
  runner: AgentMcpRunner,
  name: string,
  opts: CreateAgentOptions = {}
): Promise<void> {
  await runner.callTool('agent_create', {
    name,
    provider: agentProviderPayload(),
    permissions: opts.permissions ?? {},
    mcpServers: opts.mcpServers ?? {},
    // GUARD 1: per-agent tool-loop / delegation cap.
    maxToolLoops: MAX_TURNS,
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.allowHumanInput !== undefined ? { allowHumanInput: opts.allowHumanInput } : {}),
    ...(opts.nativeTooling !== undefined ? { nativeTooling: opts.nativeTooling } : {}),
  });
}

/** The in-process self-referential `agent-mcp` MCP server (never spawned). */
const SELF_MCP = {
  'agent-mcp': {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
  },
};

/** Poll a task's `result` until it reaches one of `statuses` (bounded deadline). */
async function pollTaskStatus(
  runner: AgentMcpRunner,
  taskId: string,
  statuses: string[],
  timeoutMs = 60_000
): Promise<{ status: string; resumeToken?: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string; resumeToken?: string | null } = { status: 'unknown' };
  while (Date.now() < deadline) {
    last = await runner.callTool<{ status: string; resumeToken?: string | null }>(
      'result',
      { task_id: taskId }
    );
    if (statuses.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/**
 * Read every stored `tool_results` blob for a task's session from the child's
 * real store. The proof that a tool REALLY ran is the tool's returned payload,
 * never the model's prose — so scenarios assert on this, not on the final text.
 */
function readToolResults(dbPath: string, taskId: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const task = db
      .prepare('SELECT session_id FROM tasks WHERE id = ?')
      .get(taskId) as { session_id: string | null } | undefined;
    if (!task?.session_id) return '';
    const rows = db
      .prepare(
        'SELECT tool_results FROM messages WHERE session_id = ? AND tool_results IS NOT NULL'
      )
      .all(task.session_id) as Array<{ tool_results: string }>;
    return rows.map((r) => r.tool_results).join('\n');
  } catch {
    return '';
  } finally {
    db.close();
  }
}

/** The child store's cumulative recorded spend for a scenario (USD). */
function costFromDb(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT COALESCE(SUM(est_cost_usd), 0) AS c FROM task_usage')
      .get() as { c: number };
    return row.c;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** Count a session's rows for an agent straight from the child's store. */
function countSessions(dbPath: string, agentName: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_name = ?')
      .get(agentName) as { n: number };
    return row.n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DAG authoring helpers (kept minimal; same shapes as the live five-AC suite)
// ─────────────────────────────────────────────────────────────────────────────

const PASS_GUARD = 'node -e "process.exit(0)"';

function milestone(opts: {
  description: string;
  agent: string;
  depends_on?: string[];
}): MilestoneDag {
  return {
    description: opts.description,
    authored_by: 'run-live-guarded',
    pending: null,
    triggered_by: null,
    phase: 'live-guard',
    depends_on: opts.depends_on ?? [],
    agent: opts.agent,
    model: 'Sonnet',
    effort: 'medium',
    two_stage: false,
    read_only: [],
    guard: PASS_GUARD,
  };
}

function op(id: string, milestoneSlug: string, description: string): OperationDag {
  return {
    id,
    milestone: milestoneSlug,
    depends_on: [],
    type: 'generative',
    action: 'create',
    file: null,
    symbol: null,
    provenance: 'manual',
    confidence: 'documented',
    audit_check: null,
    criteria: [],
    tool: null,
    args: null,
    guard: null,
    to_file: null,
    to_symbol: null,
    ki_estimate: 50,
    ki_source: 'estimate',
    authored_by: 'run-live-guarded',
    status: 'pending',
    shape: { kind: 'doc', description, objective: description, required_sections: [] },
  };
}

function newDag(opts: {
  description: string;
  milestones: Record<string, MilestoneDag>;
  operations: OperationDag[];
  terminal: string;
}): DagJson {
  return {
    schema_version: 5,
    plan_kind: 'greenfield',
    description: opts.description,
    problem: 'drive a real dispatch under hard guards',
    approach: 'real orchestrateCycle -> real AgentMcpRunner -> real agent-mcp -> real provider',
    executor: 'run-live-guarded',
    phases: ['live-guard'],
    terminal: opts.terminal,
    optimization: {
      sentinel_fanout: {
        enabled: false,
        write_multiplier: 1.25,
        read_multiplier: 0.1,
        hit_probability: 0.9,
      },
      b_per_tier: {},
      context_window_per_tier: {},
      context_window_override: null,
      b_override: null,
    },
    providers: { Sonnet: providerConfig() },
    effort_max_tokens: { medium: 4096 },
    milestones: opts.milestones,
    operations: opts.operations,
    dispatch_log: [],
  } as DagJson;
}

async function saveDag(dagPath: string, dag: DagJson): Promise<void> {
  await createDagClient(createJsonFileSerializer(dagPath)).saveDag(dag);
}

function makeDeps(dagPath: string, runner: AgentMcpRunner): OrchestratorDeps {
  let n = 0;
  return {
    client: createDagClient(createJsonFileSerializer(dagPath)),
    optimizer: { snapshot, optimize },
    runner,
    bPerTier: DEFAULT_B_PER_TIER,
    contextWindowPerTier: DEFAULT_CONTEXT_WINDOW_PER_TIER,
    clock: () => new Date().toISOString(),
    idFactory: () => `guard-${n++}`,
    sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
    poll: { intervalMs: 1000, timeoutMs: 300_000 },
    continueOnError: false,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface GuardedRun {
  cycle: Awaited<ReturnType<typeof orchestrateCycle>>;
  snapshot: UsageSnapshot;
}

/**
 * Fire ONE `orchestrateCycle` under the continuous monitor, racing the cycle
 * against the kill signal. On any guard breach the monitor closes the spawned
 * agent-mcp and wins the race with a {@link GuardAbort}. The cycle promise is
 * always settled (swallowed if it rejects after the race) so no dangling
 * rejection escapes.
 */
async function runUnderGuard(launched: Launched, dag: DagJson): Promise<GuardedRun> {
  await saveDag(launched.dagPath, dag);
  const cfg: GuardConfig = {
    dbPath: launched.dbPath,
    maxTurns: MAX_TURNS,
    maxCostUsd: MAX_COST_USD,
    maxMsgBytes: MAX_MSG_BYTES,
    pollMs: POLL_MS,
    proxy: PROXY,
    modelLabel: MODEL,
  };
  const kill = deferred<never>();
  const monitor = new RunMonitor(cfg, (err) => {
    // HARD KILL: abort the spawned agent-mcp, then win the race.
    void closeRunner(launched.runner);
    kill.reject(err);
  });
  monitor.start();

  const cyclePromise = orchestrateCycle(makeDeps(launched.dagPath, launched.runner));
  try {
    const cycle = await Promise.race([cyclePromise, kill.promise]);
    const snapshot = readUsageSnapshot(launched.dbPath);
    enforcePostRun(snapshot, cfg);
    return { cycle, snapshot: snapshot as UsageSnapshot };
  } finally {
    monitor.stop();
    // If the kill won the race, the cycle may yet reject as the closed client's
    // calls unwind — swallow it so it is never an unhandled rejection.
    cyclePromise.catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

/** Throwing inside a scenario == FAIL (with the message as detail). */
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/**
 * Guarded smoke: one real dispatch. The agent's only MCP server is the memory
 * stub with every tool hidden (`allowedTools: []` is truthy and suppresses
 * agent-mcp's fs/shell defaults), so the milestone is a single deterministic
 * model call — the guards are exercised end to end without a tool round-trip.
 */
async function scenarioDispatch(): Promise<ScenarioResult> {
  const id = 'G1';
  const name = 'guarded smoke dispatch (turns + cost + msg-size)';
  const l = launch('dispatch');
  try {
    const AGENT = 'guarded-smoke-agent';
    // A NON-EMPTY `mcpServers` map wins over agent-mcp's fs/shell defaults;
    // `allowedTools: []` (truthy) hides every tool on the stub, so the agent
    // advertises no tool and the milestone is a single deterministic model call
    // — the guards are exercised end to end without a tool round-trip.
    await createAgent(l.runner, AGENT, {
      systemPrompt: 'Follow the output instruction exactly.',
      mcpServers: {
        'memory-server': {
          transport: 'stdio',
          command: process.execPath,
          args: [MEMORY_STUB],
          allowedTools: [],
        },
      },
    });
    const dag = newDag({
      description: 'guarded smoke',
      terminal: 'smoke',
      milestones: {
        smoke: milestone({ agent: AGENT, description: 'Reply with exactly: GUARDED-OK' }),
      },
      operations: [op('smoke.1', 'smoke', 'Reply with the sentinel.')],
    });
    const { cycle, snapshot } = await runUnderGuard(l, dag);

    assert(cycle.dispatched.length === 1, `expected 1 dispatched unit, got ${cycle.dispatched.length}`);
    assert(
      cycle.dispatched[0]?.taskStatus === 'completed',
      `expected the task to complete, got ${String(cycle.dispatched[0]?.taskStatus)}`
    );
    assert(
      snapshot.modelCalls <= MAX_TURNS,
      `model calls ${snapshot.modelCalls} exceeded cap ${MAX_TURNS}`
    );
    assert(snapshot.maxMsgBytes <= MAX_MSG_BYTES, `message bytes ${snapshot.maxMsgBytes} exceeded cap`);

    return {
      id,
      name,
      status: 'PASS',
      detail:
        `task completed; ${snapshot.modelCalls}/${MAX_TURNS} model calls; ` +
        `cost $${snapshot.costUsd.toFixed(6)}/${MAX_COST_USD}; ` +
        `maxMsgBytes ${snapshot.maxMsgBytes}/${MAX_MSG_BYTES}`,
    };
  } finally {
    await closeRunner(l.runner);
    rmSync(l.scratch, { recursive: true, force: true });
  }
}

/**
 * Guarded delegation: a dispatched PARENT agent really uses the
 * agent-dispatching tools. The parent is created with the self-referential
 * `agent-mcp` MCP server (handled in-process — `clients/registry.ts`
 * `isSelfReferential`) and `permissions.allowedAgents:[child]`, then asked to
 * call `agent-mcp__agent {"name": <child>}`.
 *
 * Success is asserted by a real CHILD SESSION row — `agentTool` creates it only
 * when the dispatching tool actually executed and passed policy — plus a
 * completed parent task.
 */
async function scenarioDelegation(): Promise<ScenarioResult> {
  const id = 'G2';
  const name = 'guarded delegation (dispatched agent uses agent-mcp__agent)';
  if (!FUNCTION_TOOL_PROVIDER) {
    return {
      id,
      name,
      status: 'SKIP',
      detail:
        'provider=claudecli cannot be advertised agent-mcp client-side pseudo-tools ' +
        '(agent-mcp__agent). Use DISPATCH_E2E_PROVIDER=deepseek|anthropic.',
    };
  }
  const l = launch('delegation');
  try {
    const PARENT = 'guarded-parent';
    const CHILD = 'guarded-child';
    // Self-referential server: name === "agent-mcp" is handled in-process, so
    // the args are never actually spawned (parity with the live five-AC suite).
    const selfMcp = {
      'agent-mcp': {
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      },
    };
    await createAgent(l.runner, CHILD, {
      systemPrompt: 'You are a helper. Reply with exactly: hi.',
    });
    await createAgent(l.runner, PARENT, {
      systemPrompt:
        'You delegate work. When asked, call the agent-mcp__agent tool with ' +
        `{"name":"${CHILD}"} and report the session id it returns.`,
      permissions: { allowedAgents: [CHILD] },
      mcpServers: selfMcp,
    });

    const dag = newDag({
      description: 'guarded delegation',
      terminal: 'delegate',
      milestones: {
        delegate: milestone({
          agent: PARENT,
          description:
            `Call the agent-mcp__agent tool exactly once with {"name":"${CHILD}"}. ` +
            'Then reply that the delegation succeeded.',
        }),
      },
      operations: [op('delegate.1', 'delegate', 'Delegate to the child agent.')],
    });
    const { cycle } = await runUnderGuard(l, dag);

    assert(cycle.dispatched.length === 1, `expected 1 dispatched unit, got ${cycle.dispatched.length}`);
    assert(
      cycle.dispatched[0]?.taskStatus === 'completed',
      `expected the parent task to complete, got ${String(cycle.dispatched[0]?.taskStatus)}`
    );

    // A real child session can ONLY have been created by `agent-mcp__agent`
    // (agentTool -> sessionStore.create). This is the dispatching-tools proof.
    const sessions = await l.runner.callTool<unknown>('session_list', { agentName: CHILD });
    const list = Array.isArray(sessions)
      ? (sessions as Array<{ id?: string }>)
      : ((sessions as { sessions?: Array<{ id?: string }> }).sessions ?? []);
    assert(
      list.length >= 1,
      `the dispatched agent did not create a child session via agent-mcp__agent ` +
        `(session_list(${CHILD}) returned ${JSON.stringify(sessions)})`
    );

    return {
      id,
      name,
      status: 'PASS',
      detail:
        `parent completed; child session(s) for '${CHILD}': ${list.length} (real sub-dispatch); ` +
        `$${costFromDb(l.dbPath).toFixed(6)}`,
    };
  } finally {
    await closeRunner(l.runner);
    rmSync(l.scratch, { recursive: true, force: true });
  }
}

/** The fs server's resolved root: the LAST argv entry (`… server-filesystem <root>`). */
function fsRootOf(def: { mcpServers?: Record<string, { args?: string[] }> }): string {
  const fs = def.mcpServers?.['fs'];
  const args = fs?.args ?? [];
  return args.length > 0 ? (args[args.length - 1] as string) : '';
}

/** A minimal `DispatchUnit` for `ensureAgent` (it reads only these three fields). */
function unitFor(agentName: string, systemPrompt: string): DispatchUnit {
  return { agent_name: agentName, provider: null, systemPrompt } as unknown as DispatchUnit;
}

/**
 * N1 (AC1) — the REAL end-to-end native-tooling proof: a dispatched agent whose
 * child agent-mcp is rooted at a real dispatching directory `/P` uses the
 * `srt`-wrapped `fs` server to read `/P/hello.txt` and the `srt`-wrapped shell
 * server to run `pwd` in `/P`. The assertion reads the child's OWN store
 * (`messages.tool_results`) — the tools' returned payloads, not the model's
 * prose — so it has teeth: if the fs/shell servers never ran (or ran at the wrong
 * root) the token/path are absent.
 */
async function scenarioNativeFsShell(): Promise<ScenarioResult> {
  const id = 'N1';
  const name = 'AC1: dispatched agent reads /P/<file> + runs a shell cmd in /P';
  const base = mkdtempSync(join(TMP_ROOT, 'native-fs-shell-'));
  const P = join(base, 'P');
  mkdirSync(P, { recursive: true });
  const token = `NAT-TOOL-9-READ-OK-${Date.now()}`;
  writeFileSync(join(P, 'hello.txt'), `${token}\n`, 'utf8');
  // The DECLARATIVE native toolset STORED on the agent (ADR-0008 D3/D4): the
  // spawned child resolves it at task time against cwd P. The shell argv
  // allow-list is declarative config, not a resolved root.
  const nativeTooling = {
    fs: true,
    shell: { allowCommands: ['pwd', 'echo', 'ls', 'cat'] },
    dispatch: true,
  };
  // Hermetic: the explicit memory/backlog half swapped for local stubs. Their
  // transport is ORTHOGONAL to the native tooling under test (fs/shell/dispatch);
  // leaving the real ones would spawn an unbuilt backlog entry and hang on an
  // absent localhost SSE endpoint.
  const explicitStubs: Record<string, Record<string, unknown>> = {
    'memory-server': {
      transport: 'stdio',
      command: process.execPath,
      args: [MEMORY_STUB],
      allowedTools: [],
    },
    backlog: {
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      allowedTools: [],
    },
  };
  const l = launch('native-fs-shell', {
    cwd: P,
    dbPath: join(base, 'agents.db'),
    scratch: base,
    home: mkFakeHome(base),
    defaultMcpServers: explicitStubs,
    nativeTooling,
    createAgentsIfMissing: true,
  });
  try {
    const AGENT = 'n9-native-fs-shell';
    await createAgent(l.runner, AGENT, {
      systemPrompt:
        'You are a dispatched agent. Use the filesystem MCP tool to read files and the shell MCP ' +
        'tool to run commands. Follow the requested output format exactly.',
      mcpServers: explicitStubs,
      nativeTooling,
    });
    const dag = newDag({
      description: 'N9 fs/shell e2e',
      terminal: 'read',
      milestones: {
        read: milestone({
          agent: AGENT,
          description:
            `Use the filesystem tool to read the file "${join(P, 'hello.txt')}". ` +
            'Then use the shell tool to run the command ["pwd"]. ' +
            'Finally reply with exactly two lines: "FILECONTENT=<the file contents>" then ' +
            '"PWD=<the pwd output>".',
        }),
      },
      operations: [op('read.1', 'read', 'read the /P file and run pwd in /P')],
    });
    const { cycle, snapshot } = await runUnderGuard(l, dag);
    assert(cycle.dispatched.length === 1, `expected 1 dispatched unit, got ${cycle.dispatched.length}`);
    assert(
      cycle.dispatched[0]?.taskStatus === 'completed',
      `expected the task to complete, got ${String(cycle.dispatched[0]?.taskStatus)}`
    );
    const taskId = cycle.dispatched[0]?.taskId;
    assert(taskId, 'dispatched unit carried no taskId');
    const toolBlob = readToolResults(l.dbPath, taskId);
    assert(
      toolBlob.includes(token),
      `the fs tool never returned the /P file contents (token ${token} absent from tool_results)`
    );
    assert(
      toolBlob.includes(P),
      `the shell tool never ran its command in /P (${P} absent from tool_results)`
    );
    return {
      id,
      name,
      status: 'PASS',
      detail:
        `fs read ${token} under ${P}; shell ran in ${P}; ` +
        `${snapshot.modelCalls}/${MAX_TURNS} calls; $${costFromDb(l.dbPath).toFixed(6)}`,
    };
  } finally {
    await closeRunner(l.runner);
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * N2 (AC2) — portability of the DISPATCH HOST (ADR-0008 D4/D8): the SAME stored
 * definition fired from `/P` then `/Q` yields fs root `/P` then `/Q` while the
 * stored JSON stays byte-identical. The host stores only DECLARATIVE
 * `nativeTooling`; the spawned agent-mcp child re-resolves it against its own cwd
 * at task time, and `ensureAgent` reuse performs NO write. Deterministic (no
 * model): the resolved fs server is a cwd-echo stub read back through the child's
 * real `agent_verify_mcp` handshake.
 */
async function scenarioPortability(): Promise<ScenarioResult> {
  const id = 'N2';
  const name = 'AC2: dispatch-host portability (/P then /Q, byte-identical stored JSON)';
  const base = mkdtempSync(join(TMP_ROOT, 'portability-'));
  const P = join(base, 'P');
  const Q = join(base, 'Q');
  mkdirSync(P, { recursive: true });
  mkdirSync(Q, { recursive: true });
  const home = mkFakeHome(base);
  const dbPath = join(base, 'agents.db');
  const AGENT = 'n9-portable';
  const unit = unitFor(AGENT, 'You are a dispatched agent.');
  // A test-only stdio MCP server that exposes its inherited cwd as its tool name.
  const CWD_ECHO = join(__dirname, '..', 'fixtures', 'cwd-echo-server.mjs');
  const echoTool = (dir: string): string =>
    `at_${basename(dir).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const nativeTooling = {
    fs: { transport: 'stdio', command: process.execPath, args: [CWD_ECHO] },
    shell: false,
    dispatch: false,
  };
  const mk = (cwd: string): Launched =>
    launch('portability', {
      scratch: base,
      home,
      dbPath,
      cwd,
      // Fast-failing boundary stubs (never the thing under test).
      defaultMcpServers: {
        'memory-server': {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
        backlog: {
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      },
      nativeTooling,
      createAgentsIfMissing: true,
    });

  const probe = async (l: Launched): Promise<{ tools: string[]; stored: string }> => {
    await l.runner.ensureAgent(unit);
    const verified = await l.runner.callTool<{
      servers: Array<{ name: string; tools?: string[] }>;
    }>('agent_verify_mcp', { name: AGENT });
    const tools = verified.servers.find((s) => s.name === 'fs')?.tools ?? [];
    const def = await l.runner.callTool<{ mcpServers?: unknown }>('agent_read', {
      name: AGENT,
    });
    return { tools, stored: JSON.stringify(def.mcpServers ?? {}) };
  };

  // (1) create at /P — the resolved fs server inherits /P from the child cwd.
  const a = mk(P);
  let atP: { tools: string[]; stored: string };
  try {
    atP = await probe(a);
  } finally {
    await closeRunner(a.runner);
  }
  // NEGATIVE CONTROL (D11 #3): the stored map must carry NO baked root; if the
  // host resolved fs at /P and stored it, `/P` would appear here.
  assert(
    !atP.stored.includes(P),
    `the stored mcpServers must not carry a baked /P root: ${atP.stored}`
  );
  assert(
    atP.tools.includes(echoTool(P)),
    `resolved fs server at /P did not inherit /P (tools=${atP.tools.join(',')})`
  );

  // (2) reuse at /Q — the SAME stored def resolves /Q, and the store is untouched.
  const b = mk(Q);
  let atQ: { tools: string[]; stored: string };
  try {
    atQ = await probe(b);
  } finally {
    await closeRunner(b.runner);
  }
  assert(
    atQ.tools.includes(echoTool(Q)),
    `the SAME stored def reused at /Q did not resolve /Q (tools=${atQ.tools.join(',')})`
  );
  assert(
    atQ.stored === atP.stored,
    `reuse at /Q mutated the stored definition (byte-identical expected): ${atP.stored} vs ${atQ.stored}`
  );

  rmSync(base, { recursive: true, force: true });
  return {
    id,
    name,
    status: 'PASS',
    detail: `create@/P → ${atP.tools.join(',')}; reuse@/Q → ${atQ.tools.join(',')}; stored JSON byte-identical`,
  };
}

/**
 * N3 (AC3a) — a sessioned `ask` suspends the real task and later resumes it.
 * Drives the real spawned agent-mcp through its own `agent`/`task`/`task_resume`
 * MCP tools: the parent agent's gate returns `ask` for `agent-mcp.*`, the task
 * suspends to `awaiting_input` carrying a `resumeToken`, and resuming it executes
 * the tool — proven by a REAL child session row (only the dispatching tool writes
 * one). Needs a function-tool provider (DeepSeek/Anthropic).
 */
async function scenarioHitlAsk(): Promise<ScenarioResult> {
  const id = 'N3';
  const name = 'AC3: sessioned ask suspends + resumes (real MCP task/task_resume)';
  if (!FUNCTION_TOOL_PROVIDER) {
    return {
      id,
      name,
      status: 'SKIP',
      detail: 'provider=claudecli cannot receive agent-mcp client-side pseudo-tools; use deepseek|anthropic.',
    };
  }
  const l = launch('hitl');
  try {
    const CHILD = 'n9-hitl-child';
    const PARENT = 'n9-hitl-parent';
    await createAgent(l.runner, CHILD, { systemPrompt: 'Reply with exactly: hi.' });
    await createAgent(l.runner, PARENT, {
      systemPrompt:
        `Call the agent-mcp__agent tool exactly once with {"name":"${CHILD}"}, then reply "done".`,
      permissions: { allowedAgents: [CHILD] },
      mcpServers: SELF_MCP,
      // `dispatch:true` with an `ask` rule on the self server; `hitl:true` enables
      // the suspend branch. fs/shell disabled so no srt server spins up.
      nativeTooling: {
        fs: false,
        shell: false,
        dispatch: { permissions: { 'agent-mcp.*': 'ask' } },
        hitl: true,
      },
    });

    const { session_id } = await l.runner.callTool<{ session_id: string }>('agent', {
      name: PARENT,
    });
    const fired = await l.runner.callTool<{ task_id: string }>('task', {
      session_id,
      prompt: 'go',
      background: true,
    });
    const suspended = await pollTaskStatus(l.runner, fired.task_id, ['awaiting_input'], 90_000);
    assert(
      suspended.status === 'awaiting_input',
      `expected awaiting_input, got ${suspended.status}`
    );
    assert(suspended.resumeToken, 'a suspended task must carry a resumeToken');
    assert(
      countSessions(l.dbPath, CHILD) === 0,
      'the ask must NOT have executed the tool before approval'
    );

    await l.runner.callTool('task_resume', {
      taskId: fired.task_id,
      resumeToken: suspended.resumeToken,
      userInput: 'approve',
    });
    const done = await pollTaskStatus(l.runner, fired.task_id, ['completed', 'failed'], 90_000);
    assert(done.status === 'completed', `resumed task ended ${done.status}`);
    assert(
      countSessions(l.dbPath, CHILD) >= 1,
      'after approval the tool executed (a real child session row exists)'
    );
    return {
      id,
      name,
      status: 'PASS',
      detail:
        `suspended (token ${String(suspended.resumeToken).slice(0, 8)}…) → resumed → child session created; ` +
        `$${costFromDb(l.dbPath).toFixed(6)}`,
    };
  } finally {
    await closeRunner(l.runner);
    rmSync(l.scratch, { recursive: true, force: true });
  }
}

/**
 * N5 (AC5) — a one-shot `agent_name` task is a REAL session (`retention:
 * ephemeral`) reclaimed on terminal, while a sessioned task's session survives
 * to `session_close`. Proves the retention class is a real lifecycle, not
 * `ephemeral` = non-interactive.
 */
async function scenarioRetention(): Promise<ScenarioResult> {
  const id = 'N5';
  const name = 'AC5: ephemeral session reclaimed on terminal; retained survives';
  const l = launch('retention');
  try {
    const EPHEMERAL = 'n9-retained-ephemeral';
    const SESSIONED = 'n9-retained-sessioned';
    await createAgent(l.runner, EPHEMERAL, {
      systemPrompt: 'Reply with exactly: one.',
      nativeTooling: { fs: false, shell: false, dispatch: false },
    });
    await createAgent(l.runner, SESSIONED, {
      systemPrompt: 'Reply with exactly: two.',
      nativeTooling: { fs: false, shell: false, dispatch: false },
    });

    // One-shot (`agent_name`) → ephemeral retention, synchronous.
    const one = await l.runner.callTool<{ task_id: string; status: string }>('task', {
      agent_name: EPHEMERAL,
      prompt: 'one',
    });
    assert(one.status === 'completed', `one-shot task ended ${one.status}`);
    const tasks = await l.runner.callTool<{
      tasks?: Array<{ id: string; isEphemeral?: boolean; sessionId?: string }>;
    }>('task_list', { agentName: EPHEMERAL });
    const list = Array.isArray(tasks) ? tasks : (tasks.tasks ?? []);
    const row = list.find((t) => t.id === one.task_id);
    assert(row, 'the one-shot task is not in task_list');
    assert(row?.isEphemeral === true, 'a one-shot task must be retention=ephemeral');
    const ephSessions = await l.runner.callTool<{
      sessions?: Array<{ id: string; status?: string }>;
    }>('session_list', { agentName: EPHEMERAL });
    const ephList = Array.isArray(ephSessions) ? ephSessions : (ephSessions.sessions ?? []);
    const ephSession = ephList.find((s) => s.id === row?.sessionId);
    assert(ephSession, 'the ephemeral task must still have a real session row');
    assert(
      ephSession?.status === 'closed',
      `an ephemeral session must be reclaimed (closed) on terminal, got ${String(ephSession?.status)}`
    );

    // Sessioned → the session survives terminal (retained).
    const { session_id } = await l.runner.callTool<{ session_id: string }>('agent', {
      name: SESSIONED,
    });
    const firedSessioned = await l.runner.callTool<{ task_id: string }>('task', {
      session_id,
      prompt: 'two',
      background: true,
    });
    const done = await pollTaskStatus(
      l.runner,
      firedSessioned.task_id,
      ['completed', 'failed'],
      90_000
    );
    assert(done.status === 'completed', `sessioned task ended ${done.status}`);
    const sess = await l.runner.callTool<{
      sessions?: Array<{ id: string; status?: string }>;
    }>('session_list', { agentName: SESSIONED });
    const sList = Array.isArray(sess) ? sess : (sess.sessions ?? []);
    const live = sList.find((s) => s.id === session_id);
    assert(live, 'the sessioned session row is missing');
    assert(
      live?.status === 'active',
      `a retained session must survive a terminal task, got ${String(live?.status)}`
    );

    return {
      id,
      name,
      status: 'PASS',
      detail:
        `ephemeral session ${row?.sessionId} reclaimed (closed); sessioned session ${session_id} retained (active); ` +
        `$${costFromDb(l.dbPath).toFixed(6)}`,
    };
  } finally {
    await closeRunner(l.runner);
    rmSync(l.scratch, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function printTable(results: ScenarioResult[]): void {
  const idW = Math.max(3, ...results.map((r) => r.id.length));
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  console.log('');
  console.log('='.repeat(96));
  console.log(' run-live-guarded — guarded live dispatch (turns + cost-kill + msg-size + delegation)');
  console.log('='.repeat(96));
  for (const r of results) {
    console.log(
      ` ${r.id.padEnd(idW)} | ${r.status.padEnd(4)} | ${r.name.padEnd(nameW)} | ${r.detail}`
    );
  }
  console.log('='.repeat(96));
}

async function main(): Promise<number> {
  if (!LIVE) {
    console.warn(
      '[run-live-guarded] NOT RUN — DISPATCH_E2E_LIVE is not "1". This runner fires a real, ' +
        'billed model call; it is env-gated per AGENTS.md §7 (a real model is the single ' +
        'permitted gate reason). Gate owner: pseudosky. Run it with:\n  ' +
        RUN_COMMAND
    );
    return 0;
  }

  assertPrerequisites();
  mkdirSync(TMP_ROOT, { recursive: true });

  console.log(
    `[run-live-guarded] provider=${PROVIDER} model=${MODEL || '(cli default)'} | ` +
      `maxTurns=${MAX_TURNS} maxCostUsd=$${MAX_COST_USD} maxMsgBytes=${MAX_MSG_BYTES} ` +
      `pollMs=${POLL_MS} | proxy=${PROXY ?? '(none — relying on cost + message-size guards)'}`
  );

  const results: ScenarioResult[] = [];
  let killed = false;
  try {
    if (SCENARIO === 'all' || SCENARIO === 'dispatch') {
      results.push(await scenarioDispatch());
    }
    if (SCENARIO === 'all' || SCENARIO === 'delegation') {
      results.push(await scenarioDelegation());
    }
    // NAT-TOOL-9 (the real end-to-end proof of the native tooling, ADR-0008 D11).
    if (SCENARIO === 'all' || SCENARIO === 'native-fs-shell') {
      results.push(await scenarioNativeFsShell());
    }
    if (SCENARIO === 'all' || SCENARIO === 'portability') {
      results.push(await scenarioPortability());
    }
    if (SCENARIO === 'all' || SCENARIO === 'hitl') {
      results.push(await scenarioHitlAsk());
    }
    if (SCENARIO === 'all' || SCENARIO === 'retention') {
      results.push(await scenarioRetention());
    }
  } catch (err) {
    if (err instanceof GuardAbort) {
      killed = true;
      results.push({ id: 'KILL', name: err.reason, status: 'FAIL', detail: JSON.stringify(err.evidence) });
      console.error(`\n[run-live-guarded] HARD KILL — ${err.message}`);
    } else {
      results.push({
        id: 'ERR',
        name: 'runner error',
        status: 'FAIL',
        detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }

  printTable(results);

  const failed = results.some((r) => r.status === 'FAIL');
  if (killed) {
    console.error('[run-live-guarded] terminated by a guard — exiting non-zero.');
  }
  return failed ? 1 : 0;
}

// `main` is async but every cleanup path is inside the scenarios' `finally`;
// exit explicitly so a dangling child handle can never keep the process alive.
main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error('[run-live-guarded] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(2);
  });
