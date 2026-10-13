/**
 * R10 S8 - the end-to-end consumer proof that the R10 product changes (S1 tool results as text, S2 same-turn
 * ordering, S3 startup timings, S4 model-visible notes + delegation text + thinking docs, S5 trace signals) work
 * THROUGH the real agent-mcp server, for BOTH the Anthropic and the OpenAI-compatible adapter.
 *
 * ONE run (one scaffold, one teardown; see `r10-s8-scaffold.ts`): the real `createServer` driven by a real MCP
 * `Client`, the real stores / queue / orchestrator / host hooks / default tracing plugin, the real
 * `AnthropicProvider` and `OpenAIProvider` over HTTP to a scripted loopback model, and the real adopted fs and
 * shell MCP children. Only the model is scripted. No env gate: nothing here calls a paid third-party service.
 *
 * Scenarios, each run once per adapter, all four concurrently in `beforeAll`:
 *   work-<adapter>   an fs+shell agent. Turn 0: `write_file` then `read_text_file` of the SAME path in one turn
 *                    over a file seeded with OLD content. Turn 1: a dryRun `edit_file`, a real `edit_file` and a
 *                    `shell_execute node -e` (rejected by the adopted server's policy). Turn 2: a final reply.
 *   deleg-<adapter>  a dispatch agent. A synchronous `task`, a background `task`, then `result` with `wait_ms`
 *                    against a child agent.
 *
 * Acceptance ids (every test title carries `R10 S8 AC<n>` and the adapter):
 *   AC1  tool-result wire: CRLF file text reaches the model as raw text, once-encoded
 *   AC2  ordering: write then read of the same path in one turn sees the NEW content; results paired by id in order
 *   AC3  fs write/edit note on the wire exactly once, absent from stored history and from a dryRun edit
 *   AC4  shell rejection: actionable recovery text on the wire, allowlist unchanged
 *   AC5  delegation text: shared decision rule leads task / tasks_batch / result, identical across adapters;
 *        a synchronous task and a background task collected with `result` both complete
 *   AC6  thinking: anthropic agent_create puts the field in the request body; openai agent_create rejects the key
 *   AC7  trace: the sink holds the tool-call, startup and dispatch signals, and no prompt / reply / argument text
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveNativeToolingMap } from "@adhd/agent-core-native-tooling";
import { shellRejectionNote } from "@adhd/agent-engine-orchestrator";

import { DELEGATION_DECISION_RULE } from "../delegation-text.js";
import { FS_EDIT_NOTE, FS_WRITE_NOTE } from "../tool-result-notes.js";
import {
  ADAPTERS,
  callId,
  SENTINELS,
  startScaffold,
  seed,
  textOf,
  type AdapterKind,
  type IModelRequest,
  type IScaffold,
  type Rec,
} from "./r10-s8-scaffold.js";

const OLD_TEXT = "OLD-CONTENT-must-not-be-read\r\n";
/** CR LF line ends, quotes, a backslash and a tab: everything JSON escaping would rewrite. */
const NEW_TEXT = `export const alpha = "x"; // ${SENTINELS.arg}\r\n// path C:\\tmp\\f.js\r\n\tconst b = 'y';\r\n`;

const scenario = {
  work: (a: AdapterKind) => `work-${a}`,
  deleg: (a: AdapterKind) => `deleg-${a}`,
  child: (a: AdapterKind) => `child-${a}`,
};

interface IRun {
  work: { sessionId: string; taskId: string; status: string; result: string };
  deleg: { sessionId: string; taskId: string; status: string; result: string };
  target: string;
}

let sc: IScaffold;
const runs = {} as Record<AdapterKind, IRun>;
let thinkingAnthropic: Awaited<ReturnType<IScaffold["createAgent"]>>;
let thinkingOpenai: Awaited<ReturnType<IScaffold["createAgent"]>>;
let wallMs = 0;

/** All text of a tool-result `content` as the model sees it (a string, or the text of a block array). */
const wireText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: { text?: string }) => b.text ?? "").join("\n");
  return JSON.stringify(content);
};
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
/** Sink records of `event` (any of the span suffixes) belonging to `taskId`, in file order. */
const traced = (event: string, taskId: string): Rec[] =>
  sc.sinkRecords().filter((r) => r.event === event && r["agent.task_id"] === taskId);
const req = (a: AdapterKind, s: string, turn: number): IModelRequest => {
  const r = sc.requestsFor(s).find((x) => x.turn === turn);
  if (!r) throw new Error(`no ${a} request for ${s} turn ${turn}; have turns ${sc.requestsFor(s).map((x) => x.turn)}`);
  return r;
};

beforeAll(async () => {
  const t0 = Date.now();
  sc = await startScaffold();

  for (const a of ADAPTERS) {
    const wDir = sc.workDir(scenario.work(a));
    const target = join(wDir, "target.txt");
    seed(target, OLD_TEXT);

    sc.setScript(scenario.work(a), (r) => {
      if (r.turn === 0)
        return {
          calls: [
            { name: "fs__write_file", input: { path: target, content: NEW_TEXT } },
            { name: "fs__read_text_file", input: { path: target } },
          ],
        };
      if (r.turn === 1)
        return {
          calls: [
            { name: "fs__edit_file", input: { path: target, edits: [{ oldText: "alpha", newText: "beta" }], dryRun: true } },
            { name: "fs__edit_file", input: { path: target, edits: [{ oldText: "alpha", newText: "beta" }], dryRun: false } },
            { name: "shell__shell_execute", input: { command: ["node", "-e", "1"], timeout: 8 } },
          ],
        };
      return { text: `finished ${SENTINELS.reply}` };
    });

    sc.setScript(scenario.child(a), () => ({ text: `child finished ${SENTINELS.reply}` }));
    const child = `r10s8-child-${a}`;
    sc.setScript(scenario.deleg(a), (r) => {
      if (r.turn === 0)
        return { calls: [{ name: "agent-mcp__task", input: { agent_name: child, prompt: `sync child ${SENTINELS.prompt}` } }] };
      if (r.turn === 1)
        return { calls: [{ name: "agent-mcp__task", input: { agent_name: child, prompt: `background child ${SENTINELS.prompt}`, background: true } }] };
      if (r.turn === 2) {
        const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(wireText(r.toolResults[0]?.content))?.[0];
        return { calls: [{ name: "agent-mcp__result", input: { task_id: id ?? "missing-task-id", wait_ms: 8000 } }] };
      }
      return { text: `delegation finished ${SENTINELS.reply}` };
    });

    const created = await Promise.all([
      sc.createAgent({
        name: `r10s8-work-${a}`,
        adapter: a,
        scenario: scenario.work(a),
        fsShell: { cwd: wDir },
        ...(a === "anthropic" ? { thinking: { type: "adaptive" } } : {}),
      }),
      sc.createAgent({ name: child, adapter: a, scenario: scenario.child(a) }),
      sc.createAgent({ name: `r10s8-deleg-${a}`, adapter: a, scenario: scenario.deleg(a), dispatch: true }),
    ]);
    for (const c of created) if (c.isError) throw new Error(`agent_create failed: ${textOf(c)}`);
    runs[a] = { target } as IRun;
  }

  // The OpenAI adapter has no thinking option: the same field must be rejected by name, not silently dropped.
  thinkingAnthropic = await sc.call("agent_read", { name: "r10s8-work-anthropic" });
  thinkingOpenai = await sc.createAgent({ name: "r10s8-thinking-openai", adapter: "openai", scenario: "thinking-openai", thinking: { type: "adaptive" } });

  const results = await Promise.all(
    ADAPTERS.flatMap((a) => [
      sc.runTask(`r10s8-work-${a}`, `Write, read and edit the file. ${SENTINELS.prompt}`, sc.workDir(scenario.work(a))).then((r) => [a, "work", r] as const),
      sc.runTask(`r10s8-deleg-${a}`, `Delegate the work. ${SENTINELS.prompt}`, sc.workDir(scenario.deleg(a))).then((r) => [a, "deleg", r] as const),
    ])
  );
  for (const [a, kind, r] of results) runs[a][kind] = r;
  // the tracing plugin writes asynchronously: wait (bounded, event-yielding) until every top-level task closed
  const topLevel = ADAPTERS.flatMap((a) => [runs[a].work.taskId, runs[a].deleg.taskId]);
  await sc.waitForSink((recs) => topLevel.every((id) => recs.some((r) => r.event === "agent.task.finish" && r["agent.task_id"] === id)));
  wallMs = Date.now() - t0;
}, 120_000);

afterAll(async () => {
  expect(sc.leaks, "a request left loopback").toEqual([]);
  await sc?.dispose();
});

describe.each(ADAPTERS)("R10 S8 consumer proof [%s]", (a) => {
  it(`R10 S8 AC1 [${a}]: a CRLF file read back through the fs tool reaches the model as raw, once-encoded text`, () => {
    const r1 = req(a, scenario.work(a), 1);
    const read = r1.toolResults[1];
    const text = wireText(read.content);
    expect(typeof read.content, "tool result is a plain string on the wire").toBe("string");
    expect(text).toBe(NEW_TEXT);
    expect(text).toContain("\r\n");
    expect(text).not.toContain("\\r\\n"); // a doubly escaped CR LF would carry literal backslash-r-backslash-n
    expect(text.startsWith('[{"type"')).toBe(false);
    expect(r1.raw).not.toContain('[{\\"type\\":\\"text\\"'); // no JSON-of-the-MCP-array string anywhere in the request
    expect(r1.raw).toContain(JSON.stringify(text)); // the request body carries it exactly as JSON.stringify would
  });

  it(`R10 S8 AC2 [${a}]: write then read of one path in ONE turn sees the new content, results paired by id in order`, () => {
    const s = scenario.work(a);
    const r1 = req(a, s, 1);
    expect(r1.toolResults.map((t) => t.id)).toEqual([callId(s, 0, 0), callId(s, 0, 1)]);
    const readText = wireText(r1.toolResults[1].content);
    expect(readText).toContain(SENTINELS.arg);
    expect(readText).not.toContain("OLD-CONTENT");
    expect(wireText(r1.toolResults[0].content)).toMatch(/Successfully wrote/i);
    expect(runs[a].work.status).toBe("completed");
  });

  it(`R10 S8 AC3 [${a}]: the fs write/edit note is on the wire exactly once, not in stored history, not on a dryRun edit`, () => {
    const s = scenario.work(a);
    const r1 = req(a, s, 1);
    const r2 = req(a, s, 2);
    expect(count(r1.raw, FS_WRITE_NOTE)).toBe(1);
    expect(count(r1.raw, FS_EDIT_NOTE)).toBe(0);
    expect(count(r2.raw, FS_WRITE_NOTE), "re-applied once, not accumulated").toBe(1);
    expect(count(r2.raw, FS_EDIT_NOTE)).toBe(1);
    const [dry, real] = r2.toolResults;
    expect(wireText(dry.content)).not.toContain("[Note:");
    expect(wireText(real.content)).toContain(FS_EDIT_NOTE);
    // the stored session history is what the tools returned, byte for byte: no host note in it
    const stored = JSON.stringify(sc.harness.sessionStore.getMessages(runs[a].work.sessionId));
    expect(stored).not.toContain("[Note:");
    expect(stored).not.toContain(FS_WRITE_NOTE);
    // the edit really applied on disk, CRLF preserved
    expect(readFileSync(runs[a].target, "latin1")).toBe(NEW_TEXT.replace("alpha", "beta"));
  });

  it(`R10 S8 AC4 [${a}]: a rejected node -e yields the actionable recovery text on the wire; the allowlist is unchanged`, async () => {
    const s = scenario.work(a);
    const r2 = req(a, s, 2);
    const shell = r2.toolResults[2];
    const text = wireText(shell.content);
    expect(text).toContain("Command rejected by default security policy: node");
    expect(text).toContain(`[Note: ${shellRejectionNote("node")}]`);
    expect(count(r2.raw, JSON.stringify(`[Note: ${shellRejectionNote("node")}]`).slice(1, -1))).toBe(1);
    if (a === "anthropic") expect(shell.isError).toBe(true);
    // allowlist: the stored definition still carries exactly the catalog default (no `node`)
    const stored = JSON.parse(textOf(await sc.call("agent_read", { name: `r10s8-work-${a}`, fullDefinition: true }))) as {
      mcpServers: { shell: { env: Record<string, string> } };
    };
    const expected = resolveNativeToolingMap({ fs: true, shell: true, dispatch: false }, { cwd: sc.workDir(s), sandbox: false });
    const allow = (m: unknown): string[] => String((m as { shell: { env: Record<string, string> } }).shell.env["ALLOW_COMMANDS"]).split(",");
    expect(allow(stored.mcpServers)).toEqual(allow(expected));
    expect(allow(stored.mcpServers)).not.toContain("node");
  });

  it(`R10 S8 AC5 [${a}]: the model's task / tasks_batch lead with the shared rule; a sync and a background task both complete`, () => {
    const s = scenario.deleg(a);
    const first = req(a, s, 0);
    for (const name of ["agent-mcp__task", "agent-mcp__tasks_batch"]) {
      const d = first.tools.find((t) => t.name === name)?.description;
      expect(d?.startsWith(DELEGATION_DECISION_RULE), `${name} description leads with the rule`).toBe(true);
    }
    // identical text on both adapters (the rule is one constant, not per-adapter wording); every tool is really offered
    const other = ADAPTERS.find((x) => x !== a) as AdapterKind;
    const otherFirst = req(other, scenario.deleg(other), 0);
    for (const name of ["agent-mcp__task", "agent-mcp__tasks_batch", "agent-mcp__result"]) {
      const mine = first.tools.find((t) => t.name === name)?.description;
      expect(typeof mine === "string" && mine.length > 0, `${name} is offered to the ${a} model`).toBe(true);
      expect(mine, name).toBe(otherFirst.tools.find((t) => t.name === name)?.description);
    }
    // the sync task returned the finished child result inside the same turn
    expect(wireText(req(a, s, 1).toolResults[0].content)).toContain("child finished");
    // the background task answered pending at once, and result(wait_ms) later collected the finished child
    expect(wireText(req(a, s, 2).toolResults[0].content)).toMatch(/pending|running/);
    const collected = wireText(req(a, s, 3).toolResults[0].content);
    expect(collected).toMatch(/completed/);
    expect(collected).toContain("child finished");
    expect(runs[a].deleg.status).toBe("completed");
  });

  // KNOWN GAP (found by S8, backlog 483606ae): the in-process `result` descriptor - the one a
  // DELEGATED model sees as `agent-mcp__result` - does not lead with the shared rule, although the host-list
  // `result` does (R10 S4 AC4 covers only the host list). `it.fails` documents the gap without hiding it and turns
  // RED the moment the descriptor gains the rule, so whoever fixes it must flip this to a plain `it`.
  it.fails(`R10 S8 AC5 [${a}] KNOWN GAP: the model-visible agent-mcp__result description leads with the shared rule`, () => {
    const d = req(a, scenario.deleg(a), 0).tools.find((t) => t.name === "agent-mcp__result")?.description;
    expect(d?.startsWith(DELEGATION_DECISION_RULE)).toBe(true);
  });

  it(`R10 S8 AC5 [${a}]: the host tool list (real MCP listTools) leads task / tasks_batch / result with the same rule`, async () => {
    const tools = (await sc.client.listTools()).tools;
    for (const name of ["task", "tasks_batch", "result"]) {
      expect(tools.find((t) => t.name === name)?.description?.startsWith(DELEGATION_DECISION_RULE), name).toBe(true);
    }
  });

  it(`R10 S8 AC6 [${a}]: thinking is ${a === "anthropic" ? "on the request body" : "rejected by name"}`, () => {
    if (a === "anthropic") {
      expect(thinkingAnthropic.isError).toBeFalsy();
      for (const r of sc.requestsFor(scenario.work(a))) expect(r.body.thinking, `turn ${r.turn}`).toEqual({ type: "adaptive" });
      for (const r of sc.requestsFor(scenario.deleg(a))) expect("thinking" in r.body, "absent when unset").toBe(false);
    } else {
      expect(thinkingOpenai.isError).toBe(true);
      expect(textOf(thinkingOpenai)).toMatch(/thinking/);
      for (const r of sc.requestsFor(scenario.work(a))) expect("thinking" in r.body).toBe(false);
    }
  });
  it(`R10 S8 AC7 [${a}]: the trace sink holds tool_call concurrency/turn/group, startup timings and the sync dispatch`, () => {
    const w = runs[a].work.taskId;
    const calls = ["agent.tool_call.finish", "agent.tool_call.error"].flatMap((e) => traced(e, w));
    const byId = new Map(calls.map((r) => [String(r["agent.tool.call_id"]), r]));
    const s = scenario.work(a);
    const id = (turn: number, i: number): Rec => {
      const r = byId.get(callId(s, turn, i));
      if (!r) throw new Error(`no tool_call record for ${callId(s, turn, i)}; have ${[...byId.keys()]}`);
      return r;
    };
    expect(calls).toHaveLength(5);
    // class / turn / group: write is a barrier, the read after it is its own later group (the ordering in the trace)
    const [write, read, dry, edit, shell] = [id(0, 0), id(0, 1), id(1, 0), id(1, 1), id(1, 2)];
    expect([write, read].map((r) => r["agent.tool.concurrency_class"])).toEqual(["barrier", "safe"]);
    expect([write, read].map((r) => r["agent.tool.turn_index"])).toEqual([0, 0]);
    expect([write, read].map((r) => r["agent.tool.group_index"])).toEqual([0, 1]);
    expect([dry, edit, shell].map((r) => r["agent.tool.concurrency_class"])).toEqual(["barrier", "barrier", "barrier"]);
    expect([dry, edit, shell].map((r) => r["agent.tool.turn_index"])).toEqual([1, 1, 1]);
    expect([dry, edit, shell].map((r) => r["agent.tool.group_index"])).toEqual([0, 1, 2]);
    // the S4 notes and the rejection class are visible to the instrument without any text
    expect([write, dry, edit, shell].map((r) => r["agent.tool.note_appended"] === true)).toEqual([true, false, true, true]);
    expect(shell["agent.tool.error_class"]).toBe("policy_rejected");
    expect(shell.event).toBe("agent.tool_call.error");
    // startup: one connect timing per MCP server the agent launched, plus the tools-ready total
    const [startup] = traced("agent.task.startup.finish", w);
    expect(startup, "agent.task.startup record").toBeDefined();
    for (const server of ["fs", "shell"]) {
      expect(typeof startup[`agent.startup.mcp_connect_ms.${server}`], server).toBe("number");
    }
    expect(typeof startup["agent.startup.tools_ready_ms"]).toBe("number");
    expect(startup["agent.startup.tools_ready_ms"] as number).toBeGreaterThanOrEqual(
      Math.max(...["fs", "shell"].map((x) => startup[`agent.startup.mcp_connect_ms.${x}`] as number))
    );
    // dispatch: the sync task blocked the parent; the background one did not
    const d = runs[a].deleg.taskId;
    const dispatches = traced("agent.dispatch.finish", d).filter((r) => r["agent.dispatch.kind"] === "agent_task");
    const sync = dispatches.find((r) => r["agent.dispatch.mode"] === "sync");
    const bg = dispatches.find((r) => r["agent.dispatch.mode"] === "background");
    // the join key the instrument uses to pair the dispatch with its tool_call record (R10 S5b)
    expect(sync?.["agent.dispatch.call_id"]).toBe(callId(scenario.deleg(a), 0, 0));
    expect(typeof sync?.["agent.dispatch.parent_blocked_ms"]).toBe("number");
    expect(sync?.["agent.dispatch.parent_blocked_ms"] as number).toBeGreaterThan(0);
    expect(sync?.["agent.dispatch.children"]).toBe(1);
    expect(bg?.["agent.dispatch.parent_blocked_ms"]).toBe(0);
    expect(String(sync?.["agent.dispatch.child_task_ids"])).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("R10 S8 trace sink", () => {
  it("R10 S8 AC7: no scripted prompt, reply or tool-argument text reached the trace sink (the leak scan has teeth)", () => {
    const wire = sc.requests.map((r) => r.raw).join("\n");
    const sink = sc.sinkText();
    expect(sink.length, "sink has content").toBeGreaterThan(1000);
    for (const [kind, sentinel] of Object.entries(SENTINELS)) {
      expect(wire, `${kind} sentinel really travelled the wire`).toContain(sentinel);
      expect(sink, `${kind} sentinel leaked into the sink`).not.toContain(sentinel);
    }
    for (const a of ADAPTERS) expect(sink).not.toContain(runs[a].target); // tool-argument paths are not recorded either
  });

  it("R10 S8: one scaffold served every surface and finished well inside the budget", () => {
    console.log(`R10 S8 scenario wall ms: ${wallMs}`);
    expect(existsSync(sc.root)).toBe(true);
    expect(wallMs).toBeLessThan(60_000);
  });
});
