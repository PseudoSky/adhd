/**
 * 20772a0b-1a7e-4650-8e9d-c93101e0a1e4 AC2 / AC3 / AC4 (plan ce473fa3, bucket B5) -- the operator-visible
 * warnings `budget:unpriced_model` and `provider:builtin_bypass` reach `task_events`, not just a cast / a logger.
 *
 * Real components, no mocks of the things under test:
 *   - AC2: the real `Orchestrator` + real `BudgetPlugin` (public `createPlugin`) + real `TaskStore` on a sqlite
 *     built through the shipped migrations + a real `HookRegistry`; only the LLM boundary is scripted.
 *   - AC3: the real `createProvider` -> real `ClaudeCliProvider.chat`; only `child_process.spawn` (the external
 *     `claude` binary) is faked.
 * Both are read back through `taskEventsTable`, the way `agent-mcp-tail` / the task events reader does.
 *
 * Teeth (AC4): the "without the bridge" cases run the identical scenario without `registerTaskEventHooks` and
 * assert NO event is persisted, so deleting the wiring (host `index.ts`, or the factory's `onBuiltinBypass`)
 * turns the positive cases red. Negative control also run by hand when authored; see the commit message.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ExecutionContext } from "@adhd/agent-base-types";
import {
  HookRegistry,
  Orchestrator,
  createProvider,
  registerTaskEventHooks,
  type LLMProvider,
} from "@adhd/agent-engine-orchestrator";
import * as schema from "@adhd/agent-store-runtime";
import { TaskStore, taskEventsTable } from "@adhd/agent-store-runtime";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const TICKET = "20772a0b-1a7e-4650-8e9d-c93101e0a1e4";
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const scratch = mkdtempSync(join(tmpdir(), "20772a0b-"));

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = OFF");
  open.push(sqlite);
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  return { db, taskStore: new TaskStore(db) };
}

function ctxFor(taskId: string, model: string, providerType: "openai" | "claudecli"): ExecutionContext {
  return {
    taskId,
    sessionId: crypto.randomUUID(),
    agentName: "typed-events-agent",
    agentDefinition: {
      name: "typed-events-agent",
      version: 1,
      systemPrompt: "",
      mcpServers: {},
      permissions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    selection: { providerType, modelRef: model },
    wireModel: model,
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
}

function eventsOf(db: ReturnType<typeof makeDb>["db"], taskId: string, type: string) {
  const rows = db.select().from(taskEventsTable).where(eq(taskEventsTable.taskId, taskId)).all() as Array<{
    type: string;
    payload: string | null;
  }>;
  return rows.filter((r) => r.type === type).map((r) => JSON.parse(r.payload ?? "null") as Record<string, unknown>);
}

// ── AC2: budget:unpriced_model ────────────────────────────────────────────────

async function runUnpricedTask(withBridge: boolean) {
  const { db, taskStore } = makeDb();
  const taskId = crypto.randomUUID();
  const ctx = ctxFor(taskId, "acme-unpriced-model-9000", "openai");
  taskStore.create({ sessionId: ctx.sessionId, prompt: "p", id: taskId });

  const hooks = new HookRegistry();
  if (withBridge) registerTaskEventHooks(hooks, taskStore);
  const { createPlugin, pluginConfigSchema } = await import("@adhd/agent-plugin-budget");
  await createPlugin({
    db,
    // A $ cap on a model the rate card cannot price, with no flat rates configured.
    config: pluginConfigSchema.parse({ defaults: { cost: { maximum: 1, mode: "warning" } }, pricing: "rate-card" }),
  }).install(hooks);

  let calls = 0;
  const provider: LLMProvider = {
    chat: async () => {
      calls += 1;
      return {
        message: {
          id: crypto.randomUUID(),
          sessionId: ctx.sessionId,
          role: "assistant",
          content: "done",
          createdAt: new Date().toISOString(),
        },
        stopReason: "completed",
        usage: { inputTokens: 1000, outputTokens: 100 },
      } as never;
    },
  };
  await new Orchestrator().run({
    executionContext: ctx,
    messages: [{ id: crypto.randomUUID(), sessionId: ctx.sessionId, role: "user", content: "hi", createdAt: new Date().toISOString() }],
    registry: { listAllTools: async () => [], closeAll: async () => undefined, getClient: async () => { throw new Error("no tools"); } } as never,
    provider,
    policy: { check: () => undefined } as never,
    taskStore: taskStore as never,
    sessionStore: { appendMessage: async () => undefined, close: () => undefined } as never,
    signal: new AbortController().signal,
    taskId,
    hooks,
  });
  expect(calls).toBeGreaterThan(0);
  return { db, taskId };
}

describe(`${TICKET} AC2: an unpriced model persists a budget:unpriced_model task event`, () => {
  it(`${TICKET} AC2: the event is in task_events with the model and field`, async () => {
    const { db, taskId } = await runUnpricedTask(true);
    const events = eventsOf(db, taskId, "budget:unpriced_model");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ model: "acme-unpriced-model-9000", field: "cost", usedFlatRates: false });
    expect(events[0]).not.toHaveProperty("executionContext");
  });

  it(`${TICKET} AC4 (teeth): without the task-event bridge nothing is persisted`, async () => {
    const { db, taskId } = await runUnpricedTask(false);
    expect(eventsOf(db, taskId, "budget:unpriced_model")).toEqual([]);
  });
});

// ── AC3: provider:builtin_bypass ──────────────────────────────────────────────

const noop = (): void => undefined;
const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
function fakeProc() {
  const stdout = new Readable({ read: noop });
  queueMicrotask(() => {
    stdout.push(RESULT_LINE + "\n");
    stdout.push(null);
  });
  return { stdout, stdin: { write: () => true, end: noop }, stderr: new Readable({ read: noop }), pid: undefined, on: noop, kill: noop, exitCode: 0, killed: false };
}

async function runClaudecliTask(opts: { withBridge: boolean; builtins?: string[] }) {
  const { spawn } = await import("child_process");
  (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
  (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeProc());

  const { db, taskStore } = makeDb();
  const taskId = crypto.randomUUID();
  const ctx = ctxFor(taskId, "claude-haiku-4-5", "claudecli");
  taskStore.create({ sessionId: ctx.sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  if (opts.withBridge) registerTaskEventHooks(hooks, taskStore);

  const provider = createProvider(
    ctx.selection as never,
    {},
    { wire: { tempDir: scratch }, server: { contextLimit: 0, defaultMaxTokens: 1 }, subprocessEnv: () => ({}), resolveEnvName: () => undefined } as never,
    { info: noop, warn: noop, error: noop, debug: noop } as never,
    {
      hooks,
      executionContext: ctx,
      claudecli: opts.builtins ? { allowedBuiltinTools: opts.builtins } : {},
    }
  );
  await provider.chat({ messages: [{ role: "user", content: "go" }] } as never);
  return { db, taskId };
}

describe(`${TICKET} AC3: opted-in CLI built-ins persist a provider:builtin_bypass task event`, () => {
  it(`${TICKET} AC3: allowedBuiltinTools [Edit,Bash] -> one task event naming both and the skipped behaviours`, async () => {
    const { db, taskId } = await runClaudecliTask({ withBridge: true, builtins: ["Edit", "Bash"] });
    const events = eventsOf(db, taskId, "provider:builtin_bypass");
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("allowedBuiltinTools");
    expect(events[0].builtins).toEqual(expect.arrayContaining(["Edit", "Bash"]));
    expect(events[0].skipped).toEqual(expect.arrayContaining([expect.stringContaining("hooks")]));
    expect(events[0]).not.toHaveProperty("executionContext");
  });

  it(`${TICKET} AC3: default-deny claudecli (no built-ins) persists no bypass event`, async () => {
    const { db, taskId } = await runClaudecliTask({ withBridge: true });
    expect(eventsOf(db, taskId, "provider:builtin_bypass")).toEqual([]);
  });

  it(`${TICKET} AC4 (teeth): without the task-event bridge nothing is persisted`, async () => {
    const { db, taskId } = await runClaudecliTask({ withBridge: false, builtins: ["Edit", "Bash"] });
    expect(eventsOf(db, taskId, "provider:builtin_bypass")).toEqual([]);
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));
