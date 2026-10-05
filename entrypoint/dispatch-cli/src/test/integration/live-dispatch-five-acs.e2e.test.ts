/**
 * live-dispatch-five-acs.e2e.test.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIVE ONLY — gated behind `DISPATCH_E2E_LIVE=1`. Skipped in CI / unit runs.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * APPROVED GATE (AGENTS.md §7 — a real model is a paid/external third-party
 * service, the single permitted gate reason):
 *   - Owner: pseudosky (repo owner, skywinstonsk@gmail.com).
 *   - Recorded in: `entrypoint/dispatch-cli/README.md` ("Live dispatch e2e")
 *     and `entrypoint/dispatch-cli/AGENTS.md`. This header is the third place.
 *   - DeepSeek is a metered API; `claudecli` is driven through the host's
 *     authenticated `claude` CLI (subscription). Both are external services.
 *   - FAILS LOUDLY when enabled but a required credential/subscription is
 *     absent — never a silent skip.
 *
 * WHAT THIS PROVES
 * A single real end-to-end run through the REAL system:
 *   real DagClient/serializer → real `orchestrateCycle` → real `AgentMcpRunner`
 *   → a real spawned `@adhd/agent-mcp` (stdio JSON-RPC, real stores/engine)
 *   → a REAL provider (`claudecli` subscription by default, DeepSeek alternate).
 * The ONLY mocked boundary is the external `memory-server` MCP (not shipped in
 * this repo), stubbed by `src/test/fixtures/memory-stub-server.mjs` for AC4.
 *
 * Five live acceptance criteria (all previously UNPROVEN against a real model):
 *   AC1 fa9d3079 — `dag.session_id` threaded end-to-end: a two-milestone DAG
 *                  where B repeats a nonce that only ever appeared in A's turn;
 *                  both tasks share ONE session (verified via `task_list`).
 *   AC2 03145a46 — HITL reachable from dispatch: a sessioned task suspends to
 *                  `awaiting_input` carrying a `resumeToken`; `dispatch-cli
 *                  status` surfaces `awaitingInput: { taskId, resumeToken }`;
 *                  `task_resume` drives it to completion.
 *   AC3 5339c2e5 — the default budget plugin halts at a global cap across tasks
 *                  (`ADHD_AGENT_BUDGET_MAX_CALLS`), with BUDGET_EXCEEDED.
 *   AC4 daafe2d3 — a dispatch-created agent is born with `memory-server` and
 *                  actually calls `memory_recall` (marker file + finding echo).
 *   AC5 4e829a08 — policy enforcement survives a real dispatch-driven
 *                  delegation chain: DELEGATION_NOT_ALLOWED is surfaced.
 *
 * MODEL-INDEPENDENT INVARIANTS ONLY. Every assertion is on a structural,
 * provider-agnostic fact (a shared session id, a status, a policy error code, a
 * marker file), never on provider-specific prose.
 *
 * NEGATIVE CONTROLS (with teeth) — opt in with `DISPATCH_E2E_NEGATIVE=1`:
 *   - AC1: no `dag.session_id` → the tasks are ephemeral and B cannot echo the
 *     nonce (the positive assertion would red).
 *   - AC3: `ADHD_AGENT_DISABLE_BUDGET_PLUGIN=1` → no BUDGET_EXCEEDED halt.
 *   - AC5: the delegation target added to `allowedAgents` → the chain succeeds.
 *
 * RUN (the dispatch-cli `test` target has no `--testFile`, so invoke the package's
 * own Vitest config directly; the child agent-mcp must be built first):
 *   npx nx run agent-mcp:dist-manifest
 *   cd entrypoint/dispatch-cli && DISPATCH_E2E_LIVE=1 npx vitest run --config vite.config.ts \
 *     src/test/integration/live-dispatch-five-acs.e2e.test.ts
 *   # function-tool providers (advertise agent-mcp's client-side tools → AC2+AC5 reachable):
 *   #   anthropic-OAuth: DISPATCH_E2E_PROVIDER=anthropic (requires ADHD_AGENT_ANTHROPIC_SECRET)
 *   #   deepseek:        DISPATCH_E2E_PROVIDER=deepseek  (requires ADHD_AGENT_DEEPSEEK_SECRET)
 *   # the secrets live in ~/.adhd/.env; `set -a; source ~/.adhd/.env; set +a` before running.
 *   cd entrypoint/dispatch-cli && DISPATCH_E2E_LIVE=1 DISPATCH_E2E_PROVIDER=anthropic \
 *     npx vitest run --config vite.config.ts src/test/integration/live-dispatch-five-acs.e2e.test.ts
 *   # include negative controls:
 *   cd entrypoint/dispatch-cli && DISPATCH_E2E_LIVE=1 DISPATCH_E2E_NEGATIVE=1 \
 *     npx vitest run --config vite.config.ts src/test/integration/live-dispatch-five-acs.e2e.test.ts
 *
 * AC2 STATUS SURFACE (03145a46, now implemented; proven live 2026-10-05 under
 * deepseek): the model really calls `builtin__request_human_input` and the child
 * agent-mcp really persists the task as `awaiting_input` carrying a `resume_token`.
 * The pipeline previously could not OBSERVE it — `AgentMcpRunner.fire()` awaited a
 * SYNCHRONOUS agent-mcp `task` call (no `background:true`) while the engine's HITL
 * path blocked on `await userInputPromise`, so `fire()` — and the
 * `orchestrateCycle` awaiting it — never returned at suspension and the MCP client
 * aborted at its 60s deadline; and `dispatch-cli status` (`statusCore`) surfaced
 * only the snapshot `MilestoneStatus` vocabulary, with no `awaiting_input` member
 * and no `resumeToken`. That is fixed here: a sessioned unit fires in the
 * BACKGROUND (`fire()` sends `background:true`, taking the task id from the
 * immediate `{task_id,status:'pending'}` reply so `poll()` observes
 * `awaiting_input`), the unit is PARKED rather than failed, and `statusCore`
 * reports `awaiting_input` + `awaitingInput: { taskId, resumeToken }`. AC2 asserts
 * that surface directly, then resumes through the real MCP `task_resume` and polls
 * to completion.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  DagJson,
  MilestoneDag,
  OperationDag,
  ProviderConfig,
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

import { statusCore } from '../../lib/core.js';

import {
  AGENT_MCP_DIST,
  REPO_ROOT,
  assertAgentMcpBuilt,
} from '../helpers/agent-mcp-registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gate
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env["DISPATCH_E2E_LIVE"] === '1';
const NEGATIVE = process.env["DISPATCH_E2E_NEGATIVE"] === '1';
const PROVIDER = (process.env["DISPATCH_E2E_PROVIDER"] ?? 'claudecli') as
  | 'claudecli'
  | 'deepseek'
  | 'anthropic';

const MEMORY_STUB = join(REPO_ROOT, 'entrypoint', 'dispatch-cli', 'src', 'test', 'fixtures', 'memory-stub-server.mjs');
const TMP_ROOT = join(REPO_ROOT, 'tmp', 'dispatch-cli', 'live-five-acs');

/**
 * `claudecli` drives the `claude` CLI, which only discovers tools from the CLI's
 * own built-ins and from real MCP servers in its `--mcp-config`. It does NOT
 * receive agent-mcp's client-side pseudo-tools (`builtin__request_human_input`,
 * `agent-mcp__agent`/`task`) — the provider uses `request.tools` only to resolve
 * tool_use blocks the CLI already emitted, never to advertise them. So the
 * client-tool ACs (AC2 HITL, AC5 delegation) require a provider that advertises
 * JSON-schema function tools (DeepSeek/OpenAI or Anthropic). AC4 works under
 * claudecli because `memory-server` is a real MCP server.
 */
const FUNCTION_TOOL_PROVIDER = PROVIDER !== 'claudecli';

/** The accepted run command, surfaced in a loud failure message. */
const RUN_COMMAND =
  'cd entrypoint/dispatch-cli && DISPATCH_E2E_LIVE=1 npx vitest run --config vite.config.ts ' +
  'src/test/integration/live-dispatch-five-acs.e2e.test.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Prerequisite probes — FAIL LOUDLY, never skip silently.
// ─────────────────────────────────────────────────────────────────────────────

function assertPrerequisites(): void {
  assertAgentMcpBuilt();

  // The child `server.js` requires `../package.json`, produced by dist-manifest
  // (not plain `build`). A missing one makes the spawned server crash.
  const distPackageJson = join(REPO_ROOT, 'entrypoint', 'agent-mcp', 'dist', 'package.json');
  if (!existsSync(distPackageJson)) {
    throw new Error(
      `live dispatch e2e: ${distPackageJson} is missing — run ` +
        '`npx nx run agent-mcp:dist-manifest` first (the dispatch-cli test target depends on it).'
    );
  }

  if (!existsSync(MEMORY_STUB)) {
    throw new Error(`live dispatch e2e: memory stub fixture missing at ${MEMORY_STUB}`);
  }

  // The function-tool providers advertise JSON-schema tools, which is what
  // makes agent-mcp's client-side pseudo-tools (`builtin__request_human_input`,
  // `agent-mcp__agent`) reachable from a dispatched task. Both take their
  // credential from a `ADHD_AGENT_<PROVIDER>_SECRET` env var; neither may ever
  // silently skip when the credential is absent.
  if (PROVIDER === 'deepseek' || PROVIDER === 'anthropic') {
    const secretName =
      PROVIDER === 'deepseek' ? 'ADHD_AGENT_DEEPSEEK_SECRET' : 'ADHD_AGENT_ANTHROPIC_SECRET';
    if (!process.env[secretName]) {
      throw new Error(
        `live dispatch e2e: DISPATCH_E2E_PROVIDER=${PROVIDER} but ${secretName} is unset. ` +
          'Refusing to skip silently. Set the credential (the repo convention is to keep it ' +
          'in ~/.adhd/.env and `source` that before running), or run with the default ' +
          `claudecli provider. Run: ${RUN_COMMAND}`
      );
    }
    return;
  }

  // claudecli: require an authenticated local `claude` CLI (no API key needed).
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
      'live dispatch e2e: claudecli provider selected but `claude auth status` did not ' +
        `confirm a login (${err instanceof Error ? err.message : String(err)}). ` +
        `Run \`claude\` and log in, or use DISPATCH_E2E_PROVIDER=deepseek with a credential. Run: ${RUN_COMMAND}`
    );
  }
}

describe.skipIf(!LIVE)(
  `live dispatch e2e — five ACs through a real agent-mcp + ${PROVIDER} (DISPATCH_E2E_LIVE=1 only)`,
  () => {
    // Runs at collection only when the suite is live (skipIf still executes the
    // callback, so guard it) — a missing credential/subscription fails loudly.
    if (LIVE) assertPrerequisites();
    if (LIVE && !FUNCTION_TOOL_PROVIDER) {
      console.warn(
        '[live-five-acs] provider=claudecli: AC2 (HITL) and AC5 (delegation) are SKIPPED — the ' +
          'claude CLI cannot be advertised agent-mcp client-side tools (only real MCP servers via ' +
          '--mcp-config). Run those with DISPATCH_E2E_PROVIDER=anthropic (ADHD_AGENT_ANTHROPIC_SECRET) ' +
          'or DISPATCH_E2E_PROVIDER=deepseek (ADHD_AGENT_DEEPSEEK_SECRET). AC1/AC3/AC4 still run.'
      );
    }

    const scratchDirs: string[] = [];
    mkdirSync(TMP_ROOT, { recursive: true });

    function mkTmp(): string {
      const dir = mkdtempSync(join(TMP_ROOT, 'marker-'));
      scratchDirs.push(dir);
      return dir;
    }

    /** Provider config in dispatch-base-spec's snake_case shape. */
    function providerConfig(): ProviderConfig {
      if (PROVIDER === 'deepseek') {
        return {
          type: 'openai',
          model_id: process.env["DISPATCH_E2E_MODEL"] ?? 'deepseek-chat',
          env_secret: 'ADHD_AGENT_DEEPSEEK_SECRET',
          base_url: 'https://api.deepseek.com/v1',
          timeout_ms: 180_000,
          retry_config: { retries: 0, min_timeout: 1000, max_timeout: 5000, factor: 2 },
        };
      }
      if (PROVIDER === 'anthropic') {
        // The OAuth token from `claude setup-token` (sk-ant-oat...) resolves
        // through ADHD_AGENT_ANTHROPIC_SECRET; `claude-sonnet-4-6` is the model
        // the agent-mcp live-oauth e2e proves reachable with that token.
        return {
          type: 'anthropic',
          model_id: process.env["DISPATCH_E2E_MODEL"] ?? 'claude-sonnet-4-6',
          env_secret: 'ADHD_AGENT_ANTHROPIC_SECRET',
          base_url: null,
          timeout_ms: 180_000,
          retry_config: { retries: 0, min_timeout: 1000, max_timeout: 5000, factor: 2 },
        };
      }
      return {
        type: 'claudecli',
        model_id: process.env["DISPATCH_E2E_MODEL"] ?? '',
        env_secret: null,
        base_url: null,
        timeout_ms: 240_000,
        retry_config: { retries: 0, min_timeout: 1000, max_timeout: 5000, factor: 2 },
      };
    }

    /** The camelCase agent_create payload the MCP surface accepts. */
    function agentProviderPayload(): Record<string, unknown> {
      if (PROVIDER === 'deepseek') {
        return {
          type: 'openai',
          model: process.env["DISPATCH_E2E_MODEL"] ?? 'deepseek-chat',
          baseURL: 'https://api.deepseek.com/v1',
          env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
          timeoutMs: 180_000,
        };
      }
      if (PROVIDER === 'anthropic') {
        return {
          type: 'anthropic',
          model: process.env["DISPATCH_E2E_MODEL"] ?? 'claude-sonnet-4-6',
          env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
          timeoutMs: 180_000,
        };
      }
      const payload: Record<string, unknown> = { type: 'claudecli', timeoutMs: 240_000 };
      if (process.env["DISPATCH_E2E_MODEL"]) payload['model'] = process.env["DISPATCH_E2E_MODEL"];
      return payload;
    }

    /**
     * Build a child env: strip every ambient `ADHD_AGENT_*` (so the real
     * `~/.adhd` store can never be touched), then apply explicit overrides.
     * `HOME` and `PATH` are deliberately preserved — the `claude` CLI's OAuth
     * refresh is keychain/home-bound, and overriding `HOME` breaks `claudecli`
     * (verified: provider returns `PROVIDER_ERROR` / "OAuth session expired").
     * The `$HOME`-derived legacy-DB leak is neutralized separately by
     * `ADHD_AGENT_SKIP_LEGACY_MIGRATION` (see `launch()`).
     */
    function childEnv(overrides: Record<string, string>): Record<string, string> {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('ADHD_AGENT_')) continue;
        if (v !== undefined) env[k] = v;
      }
      const merged = { ...env, ...overrides };
      if (PROVIDER === 'deepseek') {
        merged['ADHD_AGENT_DEEPSEEK_SECRET'] = process.env["ADHD_AGENT_DEEPSEEK_SECRET"] ?? '';
      }
      if (PROVIDER === 'anthropic') {
        merged['ADHD_AGENT_ANTHROPIC_SECRET'] = process.env["ADHD_AGENT_ANTHROPIC_SECRET"] ?? '';
      }
      return merged;
    }

    interface Launched {
      runner: AgentMcpRunner;
      scratch: string;
      dagPath: string;
      dbPath: string;
    }

    function launch(opts?: {
      extraEnv?: Record<string, string>;
      defaultMcpServers?: Record<string, Record<string, unknown>>;
    }): Launched {
      const scratch = mkdtempSync(join(TMP_ROOT, `run-`));
      scratchDirs.push(scratch);
      const dbPath = join(scratch, 'agents.db');
      const runner = new AgentMcpRunner({
        command: process.execPath,
        args: [AGENT_MCP_DIST],
        cwd: scratch,
        env: childEnv({
          ADHD_AGENT_DATABASE_PATH: dbPath,
          ADHD_AGENT_REGISTRY_DB_PATH: join(scratch, 'registry.db'),
          ADHD_AGENT_SSE_ENABLED: 'false',
          ADHD_AGENT_TRANSPORT: 'stdio',
          // HERMETIC (5339c2e5 AC3): point the loader at a config path that does
          // not exist, so the developer's real `~/.adhd/agent-mcp/config.json`
          // can never load. Without this the loader's "user entry wins over
          // default" rule let a machine-global budget config (a task-scoped cap)
          // REPLACE the env-driven default entry `defaultPluginEntries()`
          // builds, and AC3's env cap was never installed. `ADHD_AGENT_CONFIG`
          // → `plugins.configPath` (agent-mcp/src/config.ts).
          ADHD_AGENT_CONFIG: join(scratch, 'no-agent-mcp-config.json'),
          // HERMETIC (af567fb8): skip agent-mcp's flat→namespaced legacy-DB
          // migration entirely, so a fresh scratch DB is NEVER seeded from the
          // developer's real `~/.adhd/agent-mcp/agents.db` (which would make a
          // global `scope:'global'` cap count the developer's real task
          // history and trip on the first milestone). `$HOME` itself cannot be
          // isolated — the `claude` CLI's OAuth refresh is keychain/home-bound
          // (a symlinked `$HOME` fails `claude -p` with "OAuth session
          // expired") — so the legacy-store read is disabled at the source
          // (`ADHD_AGENT_SKIP_LEGACY_MIGRATION` → `db.skipLegacyMigration`,
          // agent-mcp/src/config.ts / db/migrate.ts). The previous
          // post-boot `clearLegacySeed` DELETE is therefore no longer needed.
          ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true',
          ...(opts?.extraEnv ?? {}),
        }),
        defaultMcpServers: opts?.defaultMcpServers,
      });
      return { runner, scratch, dagPath: join(scratch, 'dag.json'), dbPath };
    }

    async function close(launched: Launched): Promise<void> {
      try {
        await launched.runner.close();
      } catch {
        /* best-effort */
      }
    }

    afterAll(() => {
      for (const dir of scratchDirs.splice(0)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    // ── DAG authoring helpers ─────────────────────────────────────────────────

    const PASS_GUARD = 'node -e "process.exit(0)"';

    function milestone(opts: {
      description: string;
      agent: string;
      depends_on?: string[];
    }): MilestoneDag {
      return {
        description: opts.description,
        authored_by: 'live-five-acs',
        pending: null,
        triggered_by: null,
        phase: 'e2e',
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
        authored_by: 'live-five-acs',
        status: 'pending',
        shape: { kind: 'doc', description, objective: description, required_sections: [] },
      };
    }

    function newDag(opts: {
      description: string;
      milestones: Record<string, MilestoneDag>;
      operations: OperationDag[];
      sessionId?: string | null;
      terminal?: string;
    }): DagJson {
      return {
        schema_version: 4,
        plan_kind: 'greenfield',
        description: opts.description,
        problem: 'prove the live acceptance criteria end-to-end',
        approach: 'real dispatch through a real agent-mcp with a real provider',
        executor: 'live-five-acs',
        phases: ['e2e'],
        terminal: opts.terminal ?? '',
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
        ...(opts.sessionId != null ? { session_id: opts.sessionId } : {}),
      } as DagJson;
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
        idFactory: () => `live-${n++}`,
        sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
        poll: { intervalMs: 1000, timeoutMs: 300_000 },
        // Surface a fire-time failure to the test instead of the orchestrator's
        // default swallow-and-continue (continueOnError defaults to true).
        continueOnError: false,
      };
    }

    async function saveDag(dagPath: string, dag: DagJson): Promise<void> {
      await createDagClient(createJsonFileSerializer(dagPath)).saveDag(dag);
    }

    function readDag(dagPath: string): DagJson {
      return JSON.parse(readFileSync(dagPath, 'utf8')) as DagJson;
    }

    interface TaskRow {
      id: string;
      sessionId?: string | null;
      status: string;
      result?: string | null;
      error?: string | null;
      resumeToken?: string | null;
      isEphemeral?: boolean;
    }

    async function listTasks(
      runner: AgentMcpRunner,
      args: Record<string, unknown>
    ): Promise<TaskRow[]> {
      const res = await runner.callTool<TaskRow[] | { tasks?: TaskRow[] }>('task_list', args);
      return Array.isArray(res) ? res : (res.tasks ?? []);
    }

    /**
     * Read persisted TOOL_RESULT payloads directly from the child's real
     * agent-mcp store (read-only). Proves the model's tool call returned the
     * expected payload, independent of how the model chose to phrase its answer.
     */
    function readToolResults(dbPath: string, taskId: string): string {
      const raw = new Database(dbPath, { readonly: true });
      try {
        const rows = raw
          .prepare(
            "SELECT payload FROM task_events WHERE type = 'TOOL_RESULT' AND task_id = ?"
          )
          .all(taskId) as Array<{ payload: string | null }>;
        return rows.map((r) => r.payload ?? '').join('\n');
      } finally {
        raw.close();
      }
    }

    /**
     * Hermeticity for the global-cap AC (5339c2e5). agent-mcp's flat→namespaced
     * legacy migration would seed a FRESH scratch DB from the developer's real
     * `$HOME/.adhd/agent-mcp/agents.db` (`resolveFlatLegacyDbPath`), so a
     * `scope:'global'` cap would count the developer's real task history and trip
     * on the first milestone. `$HOME` can't be isolated (claudecli OAuth is
     * keychain/home-bound), so `launch()` sets
     * `ADHD_AGENT_SKIP_LEGACY_MIGRATION=true` — the migration is never run and
     * the real legacy store is neither read nor modified (backlog af567fb8).
     * The old post-boot `clearLegacySeed` DELETE is gone: with the flag the
     * scratch DB is born empty, so there is nothing to clear.
     */

    /**
     * Provision an agent and open a REAL agent-mcp session for it, returning the
     * session id. `dag.session_id` must name an EXISTING session (the `task` tool
     * refuses an unknown id) — this is the operator step that makes a DAG's units
     * sessioned rather than ephemeral.
     */
    async function createAgentAndSession(
      runner: AgentMcpRunner,
      name: string,
      agentPayload: Record<string, unknown>
    ): Promise<string> {
      await runner.callTool('agent_create', {
        name,
        provider: agentProviderPayload(),
        permissions: {},
        mcpServers: {},
        ...agentPayload,
      });
      const opened = await runner.callTool<{ session_id?: string }>('agent', { name });
      const sessionId = opened.session_id;
      if (!sessionId) {
        throw new Error(`agent tool for '${name}' returned no session_id: ${JSON.stringify(opened)}`);
      }
      return sessionId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AC1 — fa9d3079: dag.session_id end-to-end; B repeats A's nonce
    // ─────────────────────────────────────────────────────────────────────────

    it(
      'AC1 (fa9d3079): a two-milestone sessioned DAG shares ONE session and B recalls A\'s nonce',
      async () => {
        const l = launch();
        try {
          const AGENT = 'live-nonce-agent';
          const NONCE = `NONCE-${randomUUID().slice(0, 8).toUpperCase()}`;
          const SESSION = await createAgentAndSession(l.runner, AGENT, {
            systemPrompt: 'Follow the user\'s exact output instructions.',
          });

          const dag = newDag({
            description: 'AC1 nonce session',
            sessionId: SESSION,
            terminal: 'b',
            milestones: {
              a: milestone({
                agent: AGENT,
                description:
                  `Remember this exact codeword for later: ${NONCE}. ` +
                  'Reply with exactly: ACK',
              }),
              b: milestone({
                agent: AGENT,
                depends_on: ['a'],
                description:
                  'What was the exact codeword I told you to remember in the previous turn? ' +
                  'Reply with ONLY that codeword and nothing else. If you were not told one, ' +
                  'reply exactly: UNKNOWN',
              }),
            },
            operations: [
              op('a.1', 'a', 'Acknowledge the codeword instruction.'),
              op('b.1', 'b', 'Recall the codeword from the prior turn.'),
            ],
          });
          await saveDag(l.dagPath, dag);
          const deps = makeDeps(l.dagPath, l.runner);

          const cycle1 = await orchestrateCycle(deps);
          expect(cycle1.dispatched.length).toBe(1);
          expect(cycle1.dispatched[0]?.milestones).toEqual(['a']);
          expect(cycle1.dispatched[0]?.taskStatus).toBe('completed');

          const cycle2 = await orchestrateCycle(deps);
          expect(cycle2.dispatched.length).toBe(1);
          expect(cycle2.dispatched[0]?.milestones).toEqual(['b']);
          expect(cycle2.dispatched[0]?.taskStatus).toBe('completed');

          // ── The shared-session invariant ────────────────────────────────
          const tasks = await listTasks(l.runner, {
            session_id: SESSION,
            fields: ['id', 'sessionId', 'status', 'result'],
            limit: 50,
          });

          expect(tasks.length, 'both milestones must be tasks on the ONE dag.session_id').toBe(2);
          for (const t of tasks) {
            expect(t.sessionId).toBe(SESSION);
          }

          const bTask = tasks.find((t) => (t.result ?? '').includes(NONCE));
          expect(
            bTask,
            'some task on the shared session must contain the nonce — the model could only ' +
              'know it from A\'s turn, so a match proves the session carried A\'s context to B'
          ).toBeDefined();
        } finally {
          await close(l);
        }
      },
      420_000
    );

    // ─────────────────────────────────────────────────────────────────────────
    // AC2 — 03145a46: HITL reachable from dispatch
    // ─────────────────────────────────────────────────────────────────────────

    it.skipIf(!FUNCTION_TOOL_PROVIDER)(
      'AC2 (03145a46) [needs a function-tool provider]: a sessioned dispatch task suspends to awaiting_input + resumeToken and task_resume completes it',
      async () => {
        const l = launch({ extraEnv: { ADHD_AGENT_BUDGET_MAX_CALLS: '100' } });
        try {
          const AGENT = 'live-hitl-agent';

          // The dispatched agent must be allowed to ask for human input BEFORE
          // the DAG fires it. The runner's ensureAgent does not set
          // allowHumanInput, so provision the agent explicitly (an operator step),
          // then open a real session for it so the unit is non-ephemeral.
          //
          // Isolate the tool surface to the HITL tool. agent-mcp's `agent_create`
          // default-wires filesystem + shell servers when `mcpServers` is empty
          // (defaults.ts `withDefaultMcpServers`); on the first live run under
          // anthropic the model chose the injected `shell__shell` tool instead of
          // suspending, and that call hung. Passing a NON-EMPTY map whose every
          // tool is hidden (`allowedTools: []` is truthy → registry.ts
          // `isToolHidden` drops every tool) suppresses the fs/shell defaults (an
          // explicit non-empty map always wins) AND advertises no MCP tool, so
          // `builtin__request_human_input` is the only callable tool. This is the
          // same isolation the repo's own live HITL tests achieve with an empty
          // tool registry (agent-mcp live-oauth.e2e.test.ts /
          // hitl-suspend-resume.e2e.test.ts) — it changes only test setup, never
          // product behavior.
          const HITL_ISOLATED_MCP = {
            'memory-server': {
              transport: 'stdio' as const,
              command: process.execPath,
              args: [MEMORY_STUB],
              allowedTools: [] as string[],
            },
          };
          const SESSION = await createAgentAndSession(l.runner, AGENT, {
            systemPrompt:
              'You are a deployment assistant. You have exactly one tool available: ' +
              'builtin__request_human_input. When asked to confirm, you MUST call that tool ' +
              'with the prompt "confirm deployment" and then stop. Do not answer on your own.',
            allowHumanInput: true,
            mcpServers: HITL_ISOLATED_MCP,
          });

          const dag = newDag({
            description: 'AC2 HITL from dispatch',
            sessionId: SESSION,
            terminal: 'hitl',
            milestones: {
              hitl: milestone({
                agent: AGENT,
                description:
                  'Request operator confirmation before proceeding: call the ' +
                  'builtin__request_human_input tool with prompt "confirm deployment".',
              }),
            },
            operations: [op('hitl.1', 'hitl', 'Ask the operator to confirm the deployment.')],
          });
          await saveDag(l.dagPath, dag);

          // DIAGNOSTIC (03145a46). The dispatch `fire()` path calls agent-mcp's
          // `task` tool synchronously (no `background:true`); the engine's HITL
          // path then blocks on `await userInputPromise` until a resume, so
          // `fire()` — and the cycle awaiting it — never returns at suspension
          // and the MCP client aborts the request at its 60s deadline. When that
          // happens, dump the child's REAL persisted task state so the failure
          // is unambiguously "the task DID suspend to awaiting_input with a
          // resumeToken; fire() never returned" — not "the model never called
          // the HITL tool".
          let cycle: Awaited<ReturnType<typeof orchestrateCycle>>;
          try {
            cycle = await orchestrateCycle(makeDeps(l.dagPath, l.runner));
          } catch (err) {
            const probe = new Database(l.dbPath, { readonly: true });
            let persisted: unknown;
            try {
              persisted = probe
                .prepare('SELECT id, status, resume_token FROM tasks WHERE session_id = ?')
                .all(SESSION);
            } finally {
              probe.close();
            }
            throw new Error(
              `AC2 dispatch cycle did not return: ${err instanceof Error ? err.message : String(err)}; ` +
                `persisted task rows for the session = ${JSON.stringify(persisted)}`
            );
          }
          expect(cycle.dispatched.length).toBe(1);

          // The orchestrator stops polling on awaiting_input and parks the
          // unit (not failed): the summary carries the suspension.
          expect(
            cycle.dispatched[0]?.taskStatus,
            'the dispatched task must suspend to awaiting_input (sessioned, non-ephemeral)'
          ).toBe('awaiting_input');

          // `dispatch-cli status` (statusCore) surfaces the suspension + token
          // — the previously-missing status half of this AC (03145a46).
          const report = await statusCore(l.dagPath);
          expect(
            report['hitl']?.status,
            'dispatch-cli status must report the milestone as awaiting_input'
          ).toBe('awaiting_input');
          expect(
            report['hitl']?.awaitingInput?.resumeToken,
            'dispatch-cli status must surface the resumeToken'
          ).toBeTruthy();

          // The real MCP surface exposes the suspended task + its resumeToken.
          const tasks = await listTasks(l.runner, {
            session_id: SESSION,
            fields: ['id', 'sessionId', 'status', 'resumeToken', 'isEphemeral'],
            limit: 10,
          });
          expect(tasks.length).toBe(1);
          const suspended = tasks[0];
          expect(suspended?.status).toBe('awaiting_input');
          expect(suspended?.isEphemeral, 'HITL requires a non-ephemeral (sessioned) task').toBe(false);
          const token = suspended?.resumeToken;
          expect(token, 'an awaiting_input task must carry a resumeToken').toBeTruthy();

          // Resume through the REAL MCP task_resume tool.
          await l.runner.callTool('task_resume', {
            taskId: suspended?.id,
            resumeToken: token,
            userInput: 'approved',
          });

          // Poll the task to completion on the real surface.
          const deadline = Date.now() + 120_000;
          let final: TaskRow | undefined;
          while (Date.now() < deadline) {
            const rows = await listTasks(l.runner, {
              session_id: SESSION,
              fields: ['id', 'status', 'result'],
              limit: 10,
            });
            final = rows[0];
            if (final?.status === 'completed' || final?.status === 'failed') break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          expect(final?.status, `task did not complete after resume (last: ${final?.status})`).toBe(
            'completed'
          );
        } finally {
          await close(l);
        }
      },
      420_000
    );

    // ─────────────────────────────────────────────────────────────────────────
    // AC3 — 5339c2e5: default budget plugin halts at a global cap across tasks
    // ─────────────────────────────────────────────────────────────────────────

    it(
      'AC3 (5339c2e5): the DEFAULT budget plugin halts a multi-task run at a global cap with BUDGET_EXCEEDED',
      async () => {
        // Deterministic single-model-call tasks (5339c2e5). The dispatch system
        // preamble tells the worker to "produce real output (code, docs, or
        // config)", so a tools-enabled agent may call a filesystem/shell tool —
        // a SECOND model request — which makes a cumulative cap depend on the
        // model's variable turn count. `allowedTools: []` hides every tool on
        // the one server (`McpClientRegistry.isToolHidden`: an empty allowlist is
        // truthy, so every tool is hidden), so each milestone is exactly ONE
        // model call and the global cap accumulates across the two tasks
        // deterministically. The single server is the real memory-stub (a live
        // MCP server), so nothing fails to connect.
        const l = launch({
          defaultMcpServers: {
            'memory-server': {
              transport: 'stdio',
              command: process.execPath,
              args: [MEMORY_STUB],
              allowedTools: [],
            },
          },
          // A GLOBAL model-call cap of 1: m1's own pre-flight sees 0 calls
          // (fresh store; its own row is excluded) and completes with one
          // persisted call; m2's first pre-flight then reads that persisted
          // call globally and is halted — the cumulative-across-tasks property.
          extraEnv: { ADHD_AGENT_BUDGET_MAX_CALLS: '1' },
        });
        try {
          const AGENT = 'live-budget-agent';
          const dag = newDag({
            description: 'AC3 default budget cap',
            terminal: 'm2',
            milestones: {
              m1: milestone({ agent: AGENT, description: 'Reply with exactly: ONE' }),
              m2: milestone({
                agent: AGENT,
                depends_on: ['m1'],
                description: 'Reply with exactly: TWO',
              }),
            },
            operations: [
              op('m1.1', 'm1', 'Reply with ONE.'),
              op('m2.1', 'm2', 'Reply with TWO.'),
            ],
          });
          await saveDag(l.dagPath, dag);
          const deps = makeDeps(l.dagPath, l.runner);

          // Sequential: each milestone is its own task, so the global cap is
          // consumed across tasks (the point of the AC).
          const cycle1 = await orchestrateCycle(deps);
          expect(cycle1.dispatched[0]?.milestones).toEqual(['m1']);
          expect(cycle1.dispatched[0]?.taskStatus).toBe('completed');

          const cycle2 = await orchestrateCycle(deps);
          expect(cycle2.dispatched[0]?.milestones).toEqual(['m2']);
          expect(
            cycle2.dispatched[0]?.taskStatus,
            'the second task must be halted by the global cap'
          ).toBe('failed');

          const dagAfter = readDag(l.dagPath);
          const noteText = dagAfter.dispatch_log
            .flatMap((e) => e.notes ?? [])
            .map((n) => n.text)
            .join('\n');
          expect(noteText).toContain('BUDGET_EXCEEDED');
        } finally {
          await close(l);
        }
      },
      420_000
    );

    // ─────────────────────────────────────────────────────────────────────────
    // AC4 — daafe2d3: default mcpServers; the agent really calls memory_recall
    // ─────────────────────────────────────────────────────────────────────────

    it(
      'AC4 (daafe2d3): a dispatch-created agent is born with memory-server and really calls memory_recall',
      async () => {
        const FINDING = 'MEMORY-FINDING: never git stash in this repo; it corrupts the nx graph.';
        // The stub is the external boundary; the marker proves it was invoked.
        const marker = join(mkTmp(), 'memory-invoked.marker');
        const l = launch({
          defaultMcpServers: {
            'memory-server': {
              transport: 'stdio',
              command: process.execPath,
              args: [MEMORY_STUB],
              env: { MEMORY_STUB_MARKER: marker, MEMORY_STUB_FINDING: FINDING },
            },
          },
        });
        try {
          const AGENT = 'live-memory-agent';
          const dag = newDag({
            description: 'AC4 memory recall',
            terminal: 'recall',
            milestones: {
              recall: milestone({
                agent: AGENT,
                description:
                  "Call the memory_recall tool with query 'git stash in this repo'. " +
                  'Then reply with the EXACT finding text the tool returned, verbatim.',
              }),
            },
            operations: [op('recall.1', 'recall', 'Recall the git-stash finding from memory.')],
          });
          await saveDag(l.dagPath, dag);

          const cycle = await orchestrateCycle(makeDeps(l.dagPath, l.runner));
          expect(cycle.dispatched[0]?.taskStatus).toBe('completed');

          // 1. The tool was really invoked — the memory-server stub (the
          //    external boundary) recorded the call. This is the model-
          //    independent evidence under EVERY provider, including claudecli
          //    (whose CLI executes MCP servers itself, so agent-mcp records no
          //    TOOL_RESULT event for the call).
          expect(existsSync(marker), 'memory_recall must have been called on the memory-server').toBe(
            true
          );
          expect(readFileSync(marker, 'utf8')).toContain('memory_recall');

          // 2. The tool's RESULT carried the finding back to the agent. Only
          //    observable when agent-mcp itself drives the tool (a
          //    function-tool provider); under claudecli the MCP call runs inside
          //    the CLI and is invisible to agent-mcp's persistence.
          if (FUNCTION_TOOL_PROVIDER) {
            const taskId = cycle.dispatched[0]?.taskId;
            expect(taskId, 'the dispatched unit must have a task id').toBeTruthy();
            const toolResults = readToolResults(l.dbPath, taskId as string);
            expect(
              toolResults,
              'the memory_recall TOOL_RESULT payload must carry the finding the stub returned'
            ).toContain(FINDING);
          }
        } finally {
          await close(l);
        }
      },
      420_000
    );

    // ─────────────────────────────────────────────────────────────────────────
    // AC5 — 4e829a08: policy enforcement survives a dispatch delegation chain
    // ─────────────────────────────────────────────────────────────────────────

    it.skipIf(!FUNCTION_TOOL_PROVIDER)(
      'AC5 (4e829a08) [needs a function-tool provider]: a dispatch-driven delegation to a disallowed agent is stopped with DELEGATION_NOT_ALLOWED',
      async () => {
        const l = launch();
        try {
          const PARENT = 'live-policy-parent';
          const CHILD = 'live-policy-child';
          const selfMcp = {
            'agent-mcp': {
              transport: 'stdio',
              command: process.execPath,
              args: ['-e', 'process.exit(0)'],
            },
          };

          // Provision the child, then the parent with an EMPTY allowlist so the
          // delegation must be refused by the real PolicyEngine.
          await l.runner.callTool('agent_create', {
            name: CHILD,
            provider: agentProviderPayload(),
            systemPrompt: 'You are a helper. Reply with exactly: hi.',
            permissions: {},
            mcpServers: {},
          });
          await l.runner.callTool('agent_create', {
            name: PARENT,
            provider: agentProviderPayload(),
            systemPrompt:
              'You delegate work. When asked to delegate to an agent, call the agent-mcp__agent ' +
              'tool with {"name":"<name>"}. If it fails, reply with the exact error text.',
            permissions: { allowedAgents: [] },
            mcpServers: selfMcp,
          });

          const dag = newDag({
            description: 'AC5 policy delegation',
            terminal: 'delegate',
            milestones: {
              delegate: milestone({
                agent: PARENT,
                description:
                  `Delegate to the agent named ${CHILD}: call the agent-mcp__agent tool with ` +
                  `{"name":"${CHILD}"}. If the call fails, reply with the exact error text.`,
              }),
            },
            operations: [op('delegate.1', 'delegate', 'Delegate to the child agent.')],
          });
          await saveDag(l.dagPath, dag);

          const cycle = await orchestrateCycle(makeDeps(l.dagPath, l.runner));
          expect(cycle.dispatched[0]?.taskStatus).toBe('failed');

          const dagAfter = readDag(l.dagPath);
          const noteText = dagAfter.dispatch_log
            .flatMap((e) => e.notes ?? [])
            .map((n) => n.text)
            .join('\n');
          expect(noteText).toContain('DELEGATION_NOT_ALLOWED');
        } finally {
          await close(l);
        }
      },
      420_000
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Negative controls (opt in: DISPATCH_E2E_NEGATIVE=1)
    // ─────────────────────────────────────────────────────────────────────────

    describe.skipIf(!NEGATIVE)('negative controls (DISPATCH_E2E_NEGATIVE=1)', () => {
      it(
        'AC1 control: WITHOUT dag.session_id the nonce cannot be recalled (ephemeral tasks)',
        async () => {
          const l = launch();
          try {
            const NONCE = `NONCE-${randomUUID().slice(0, 8).toUpperCase()}`;
            const AGENT = 'live-nonce-control-agent';
            const dag = newDag({
              description: 'AC1 negative control',
              // deliberately NO sessionId
              terminal: 'b',
              milestones: {
                a: milestone({ agent: AGENT, description: `Remember this codeword: ${NONCE}. Reply exactly: ACK` }),
                b: milestone({
                  agent: AGENT,
                  depends_on: ['a'],
                  description:
                    'What codeword did I tell you to remember? Reply with ONLY the codeword. ' +
                    'If you were not told one, reply exactly: UNKNOWN',
                }),
              },
              operations: [op('a.1', 'a', 'Ack.'), op('b.1', 'b', 'Recall.')],
            });
            await saveDag(l.dagPath, dag);
            const deps = makeDeps(l.dagPath, l.runner);
            const c1 = await orchestrateCycle(deps);
            const c2 = await orchestrateCycle(deps);

            const ids = [c1.dispatched[0]?.taskId, c2.dispatched[0]?.taskId].filter(
              (id): id is string => typeof id === 'string'
            );
            expect(ids.length).toBe(2);
            const rows: TaskRow[] = [];
            for (const id of ids) {
              rows.push(
                await l.runner.callTool<TaskRow>('result', {
                  task_id: id,
                  fields: ['id', 'status', 'result', 'isEphemeral'],
                })
              );
            }
            for (const t of rows) expect(t.isEphemeral).toBe(true);
            const bResult = rows.map((t) => t.result ?? '').join('\n');
            expect(
              bResult,
              'a control run with no session_id must NOT be able to recall the nonce'
            ).not.toContain(NONCE);
          } finally {
            await close(l);
          }
        },
        420_000
      );

      it(
        'AC3 control: with the budget plugin DISABLED no BUDGET_EXCEEDED halt occurs',
        async () => {
          const l = launch({
            // Same deterministic single-call, tool-less setup as the positive
            // AC3, but the budget plugin is removed entirely (opt-out) — the
            // identical two tasks must then run past the cap with no halt,
            // proving the halt in the positive test is the plugin's doing.
            defaultMcpServers: {
              'memory-server': {
                transport: 'stdio',
                command: process.execPath,
                args: [MEMORY_STUB],
                allowedTools: [],
              },
            },
            extraEnv: {
              ADHD_AGENT_BUDGET_MAX_CALLS: '1',
              ADHD_AGENT_DISABLE_BUDGET_PLUGIN: '1',
            },
          });
          try {
            const AGENT = 'live-budget-control-agent';
            const dag = newDag({
              description: 'AC3 negative control',
              terminal: 'm2',
              milestones: {
                m1: milestone({ agent: AGENT, description: 'Reply with exactly: ONE' }),
                m2: milestone({
                  agent: AGENT,
                  depends_on: ['m1'],
                  description: 'Reply with exactly: TWO',
                }),
              },
              operations: [op('m1.1', 'm1', 'Reply ONE.'), op('m2.1', 'm2', 'Reply TWO.')],
            });
            await saveDag(l.dagPath, dag);
            const deps = makeDeps(l.dagPath, l.runner);
            const c1 = await orchestrateCycle(deps);
            const c2 = await orchestrateCycle(deps);
            const noteText = readDag(l.dagPath)
              .dispatch_log.flatMap((e) => e.notes ?? [])
              .map((n) => n.text)
              .join('\n');
            expect(noteText).not.toContain('BUDGET_EXCEEDED');
            expect(c1.dispatched[0]?.taskStatus).toBe('completed');
            expect(c2.dispatched[0]?.taskStatus).toBe('completed');
          } finally {
            await close(l);
          }
        },
        420_000
      );

      it.skipIf(!FUNCTION_TOOL_PROVIDER)(
        'AC5 control: allowing the child agent lets the same delegation chain succeed',
        async () => {
          const l = launch();
          try {
            const PARENT = 'live-policy-control-parent';
            const CHILD = 'live-policy-control-child';
            const selfMcp = {
              'agent-mcp': {
                transport: 'stdio',
                command: process.execPath,
                args: ['-e', 'process.exit(0)'],
              },
            };
            await l.runner.callTool('agent_create', {
              name: CHILD,
              provider: agentProviderPayload(),
              systemPrompt: 'You are a helper. Reply with exactly: hi.',
              permissions: {},
              mcpServers: {},
            });
            await l.runner.callTool('agent_create', {
              name: PARENT,
              provider: agentProviderPayload(),
              systemPrompt:
                'You delegate work. Call agent-mcp__agent with ' +
                `{"name":"${CHILD}"} when asked.`,
              permissions: { allowedAgents: [CHILD] },
              mcpServers: selfMcp,
            });
            const dag = newDag({
              description: 'AC5 negative control',
              terminal: 'delegate',
              milestones: {
                delegate: milestone({
                  agent: PARENT,
                  description:
                    `Delegate to ${CHILD}: call agent-mcp__agent with ` +
                    `{"name":"${CHILD}"}.`,
                }),
              },
              operations: [op('delegate.1', 'delegate', 'Delegate.')],
            });
            await saveDag(l.dagPath, dag);
            const cycle = await orchestrateCycle(makeDeps(l.dagPath, l.runner));
            expect(cycle.dispatched[0]?.taskStatus).toBe('completed');
          } finally {
            await close(l);
          }
        },
        420_000
      );
    });
  }
);
