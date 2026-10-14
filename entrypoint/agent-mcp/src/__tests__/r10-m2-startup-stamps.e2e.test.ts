/**
 * R10 M2 - the product stamps the two start-up times the engine cannot see (`queueWaitMs`, `sessionMs`), measured in
 * `tools/task.ts`, THROUGH the real agent-mcp server for BOTH model adapters. Same scaffold as the S8 proof (real
 * `createServer` driven by a real MCP `Client`, real stores / queue / orchestrator / host hooks / tracing plugin, the
 * real `AnthropicProvider` and `OpenAIProvider` over HTTP to a scripted loopback model). Only the model is scripted.
 * No env gate: nothing here calls a paid third-party service. claudecli is not driven here (it needs the `claude`
 * binary): it runs the same `Orchestrator.run` path, proven in the engine package's `r10-m2-startup-stamps.test.ts`.
 *
 *   M2-AC1  a sync `task` dispatched by a delegating model: the child's `agent.task.startup` record carries
 *           `agent.startup.session_ms` and `agent.startup.queue_wait_ms` as integers >= 0
 *   M2-AC2  their sum <= the child's pre-start gap (child `agent.task` start - the parent's `agent.tool_call` start) + 5 ms
 *   M2-AC3  a delayed session creation raises `session_ms` by at least the delay (the stamp is measured, not a constant)
 *   M2-AC4  a direct MCP `task` call (no dispatching parent) leaves both attributes ABSENT from the record (not 0)
 *
 * guards: the `queueWaitMs` / `sessionMs` start-up stamps are missing, constant, negative, larger than the real pre-start gap, or
 *   present as 0 instead of absent on a direct (non-dispatched) task call, when driven through the assembled server.
 * tier: P (the e2e lane; real createServer, MCP Client, queue, stores and an HTTP loopback model; only the model is scripted)
 * gap: This cannot be observed at tier S because the stamps are measured on the wall clock across the real MCP server, queue, session creation and an HTTP round trip to a real model adapter, none of which a stubbed unit run crosses.
 * cites: R10 M2 AC1-AC4 (this file names no backlog uid).
 */
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADAPTERS, startScaffold, textOf, type AdapterKind, type IScaffold, type Rec } from "./r10-s8-scaffold.js";

let sc: IScaffold;

const names = {
  parent: (a: AdapterKind) => `m2-parent-${a}`,
  child: (a: AdapterKind) => `m2-child-${a}`,
  delayedChild: (a: AdapterKind) => `m2-slow-child-${a}`,
  scenario: { parent: (a: AdapterKind) => `m2p-${a}`, slow: (a: AdapterKind) => `m2s-${a}`, child: (a: AdapterKind) => `m2c-${a}`, direct: (a: AdapterKind) => `m2d-${a}` },
};

interface IRun {
  parentTaskId: string;
  slowParentTaskId: string;
  childTaskId: string;
  slowChildTaskId: string;
  directChildTaskId: string;
}
const runs = {} as Record<AdapterKind, IRun>;
let baselineSessionMs = {} as Record<AdapterKind, number>;
const DELAY_MS = 60;

const ofTask = (event: string, taskId: string): Rec | undefined =>
  sc.sinkRecords().find((r) => r.event === event && r["agent.task_id"] === taskId);
const whole = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
const childOf = (parentTaskId: string, callId?: string): string => {
  const d = sc
    .sinkRecords()
    .find((r) => r.event === "agent.dispatch.finish" && r["agent.task_id"] === parentTaskId && r["agent.dispatch.kind"] === "agent_task" && (callId === undefined || r["agent.dispatch.call_id"] === callId));
  const id = String(d?.["agent.dispatch.child_task_ids"] ?? "");
  if (!id) throw new Error(`no dispatch child for parent ${parentTaskId}`);
  return id;
};

beforeAll(async () => {
  sc = await startScaffold();

  // The slow create: a bounded spin on the same clock the stamp reads, so session_ms >= DELAY_MS by construction.
  const store = sc.harness.sessionStore as { create: (...a: unknown[]) => unknown };
  const realCreate = store.create.bind(store);
  store.create = (...args: unknown[]) => {
    const spec = args[0] as { agentName?: string } | undefined;
    if (spec?.agentName?.startsWith("m2-slow-child-")) {
      const until = performance.now() + DELAY_MS;
      while (performance.now() < until) {
        /* hold the create in flight; the lower bound is exact, never a sleep */
      }
    }
    return realCreate(...args);
  };

  for (const a of ADAPTERS) {
    const child = names.child(a);
    const slow = names.delayedChild(a);
    sc.setScript(names.scenario.child(a), () => ({ text: "child done" }));
    sc.setScript(names.scenario.direct(a), () => ({ text: "direct child done" }));
    sc.setScript(names.scenario.parent(a), (r) =>
      r.turn === 0
        ? { calls: [{ name: "agent-mcp__task", input: { agent_name: child, prompt: "do the child work" } }] }
        : { text: "parent done" }
    );
    sc.setScript(names.scenario.slow(a), (r) =>
      r.turn === 0
        ? { calls: [{ name: "agent-mcp__task", input: { agent_name: slow, prompt: "do the slow child work" } }] }
        : { text: "slow parent done" }
    );
    const created = await Promise.all([
      sc.createAgent({ name: child, adapter: a, scenario: names.scenario.child(a) }),
      sc.createAgent({ name: slow, adapter: a, scenario: names.scenario.child(a) }),
      sc.createAgent({ name: names.parent(a), adapter: a, scenario: names.scenario.parent(a), dispatch: true }),
      sc.createAgent({ name: `m2-slow-parent-${a}`, adapter: a, scenario: names.scenario.slow(a), dispatch: true }),
      sc.createAgent({ name: `m2-direct-${a}`, adapter: a, scenario: names.scenario.direct(a) }),
    ]);
    for (const c of created) if (c.isError) throw new Error(`agent_create failed: ${textOf(c)}`);
  }

  for (const a of ADAPTERS) {
    const cwd = sc.workDir(names.scenario.parent(a));
    const parent = await sc.runTask(names.parent(a), "delegate", cwd);
    const slowParent = await sc.runTask(`m2-slow-parent-${a}`, "delegate slowly", cwd);
    // M2-AC4: the same kind of child, called directly through the MCP surface (no dispatching parent)
    const direct = await sc.call("task", { agent_name: `m2-direct-${a}`, prompt: "direct", cwd });
    expect(direct.isError, textOf(direct)).toBeFalsy();
    const directTaskId = (JSON.parse(textOf(direct)) as { task_id: string }).task_id;
    // the child ids are resolved below, once the sink holds the dispatch records
    runs[a] = { parentTaskId: parent.taskId, slowParentTaskId: slowParent.taskId, childTaskId: "", slowChildTaskId: "", directChildTaskId: directTaskId };
  }
  await sc.waitForSink((recs) =>
    ADAPTERS.every((a) => {
      const slowParent = runs[a].slowParentTaskId;
      return [runs[a].parentTaskId, slowParent, runs[a].directChildTaskId].every((id) => recs.some((r) => r.event === "agent.task.finish" && r["agent.task_id"] === id)) &&
        recs.filter((r) => r.event === "agent.dispatch.finish" && (r["agent.task_id"] === runs[a].parentTaskId || r["agent.task_id"] === slowParent)).length >= 2;
    })
  );
  for (const a of ADAPTERS) {
    runs[a].childTaskId = childOf(runs[a].parentTaskId);
    runs[a].slowChildTaskId = childOf(runs[a].slowParentTaskId);
    await sc.waitForSink((recs) =>
      [runs[a].childTaskId, runs[a].slowChildTaskId].every((id) => recs.some((r) => r.event === "agent.task.startup.finish" && r["agent.task_id"] === id))
    );
  }
  baselineSessionMs = Object.fromEntries(ADAPTERS.map((a) => [a, ofTask("agent.task.startup.finish", runs[a].childTaskId)?.["agent.startup.session_ms"] as number])) as Record<AdapterKind, number>;
}, 120_000);

afterAll(async () => {
  expect(sc.leaks, "a request left loopback").toEqual([]);
  await sc?.dispose();
});

describe.each(ADAPTERS)("R10 M2 startup stamps through the real server [%s]", (a) => {
  it(`R10 M2 AC1 [${a}]: the sync child's agent.task.startup carries session_ms and queue_wait_ms as integers >= 0`, () => {
    const startup = ofTask("agent.task.startup.finish", runs[a].childTaskId);
    expect(startup, "child startup record").toBeDefined();
    expect(whole(startup?.["agent.startup.session_ms"]), `session_ms=${startup?.["agent.startup.session_ms"]}`).toBe(true);
    expect(whole(startup?.["agent.startup.queue_wait_ms"]), `queue_wait_ms=${startup?.["agent.startup.queue_wait_ms"]}`).toBe(true);
  });

  it(`R10 M2 AC2 [${a}]: session_ms + queue_wait_ms <= the child's pre-start gap (child agent.task start - parent tool_call start) + 5 ms`, () => {
    const recs = sc.sinkRecords();
    const dispatch = recs.find((r) => r.event === "agent.dispatch.finish" && r["agent.task_id"] === runs[a].parentTaskId && r["agent.dispatch.kind"] === "agent_task");
    const callId = String(dispatch?.["agent.dispatch.call_id"] ?? "");
    expect(callId, "dispatch call_id join key").not.toBe("");
    const parentCall = recs.find((r) => r.event === "agent.tool_call.start" && r["agent.task_id"] === runs[a].parentTaskId && r["agent.tool.call_id"] === callId);
    const childStart = recs.find((r) => r.event === "agent.task.start" && r["agent.task_id"] === runs[a].childTaskId);
    expect(parentCall, "parent tool_call start record").toBeDefined();
    expect(childStart, "child task start record").toBeDefined();
    const gap = Date.parse(String(childStart?.["ts"])) - Date.parse(String(parentCall?.["ts"]));
    const startup = ofTask("agent.task.startup.finish", runs[a].childTaskId) as Rec;
    const sum = (startup["agent.startup.session_ms"] as number) + (startup["agent.startup.queue_wait_ms"] as number);
    expect(gap, "gap is a real positive interval").toBeGreaterThanOrEqual(0);
    expect(sum).toBeLessThanOrEqual(gap + 5);
  });

  it(`R10 M2 AC3 [${a}]: a session create held for ${DELAY_MS} ms raises session_ms by at least that much`, () => {
    const slow = ofTask("agent.task.startup.finish", runs[a].slowChildTaskId) as Rec;
    const ms = slow["agent.startup.session_ms"] as number;
    expect(ms).toBeGreaterThanOrEqual(DELAY_MS);
    expect(ms - baselineSessionMs[a]).toBeGreaterThanOrEqual(DELAY_MS - 5);
    // the delay is the session's alone: the queue wait of a sync dispatch is not inflated by it
    expect(slow["agent.startup.queue_wait_ms"] as number).toBeLessThan(DELAY_MS);
  });

  it(`R10 M2 AC4 [${a}]: a direct MCP task call (no dispatching parent) leaves both attributes absent, not 0`, () => {
    const startup = ofTask("agent.task.startup.finish", runs[a].directChildTaskId);
    expect(startup, "direct child startup record").toBeDefined();
    expect("agent.startup.session_ms" in (startup as Rec)).toBe(false);
    expect("agent.startup.queue_wait_ms" in (startup as Rec)).toBe(false);
    // the rest of the startup record is intact
    expect(typeof startup?.["agent.startup.tools_ready_ms"]).toBe("number");
  });
});
