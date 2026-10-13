/**
 * R10 W2 - the in-process `result` tool a DELEGATED worker model sees leads with the shared DELEGATION_DECISION_RULE,
 * and the change is text only: the input schemas the model sees on the wire (task, tasks_batch, result) are
 * byte-identical to what they were before the descriptor changed. Same scaffold as the S8 proof (real server, real
 * stores / queue / orchestrator / host hooks, the REAL `AnthropicProvider` and `OpenAIProvider` over HTTP to a
 * scripted loopback model). The S8 file carries the plain `it` for the lead (backlog 483606ae); this file adds what
 * S8 does not: the schema-hash pins and the per-adapter wire shape.
 *
 *   W2-AC1  `agent-mcp__result` description starts with the rule, on the Anthropic wire AND the OpenAI wire
 *   W2-AC2  the schema each tool shows the model (Anthropic `input_schema`, OpenAI `function.parameters`) hashes to the
 *           value captured BEFORE the descriptor change
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DELEGATION_DECISION_RULE } from "../delegation-text.js";
import { ADAPTERS, startScaffold, textOf, type AdapterKind, type IModelRequest, type IScaffold } from "./r10-s8-scaffold.js";

let sc: IScaffold;
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const scenario = (a: AdapterKind): string => `w2-${a}`;

/** The schema the model is shown for `tool`, as each adapter puts it on the wire. */
function wireSchema(req: IModelRequest, tool: string): unknown {
  const tools = (req.body.tools ?? []) as Array<Record<string, unknown>>;
  if (req.adapter === "anthropic") return tools.find((t) => t["name"] === tool)?.["input_schema"];
  return (tools.find((t) => (t["function"] as { name: string }).name === tool)?.["function"] as { parameters?: unknown } | undefined)?.parameters;
}

/** Hashes captured on the wire BEFORE the `result` descriptor changed (R10 S8 build, 9487192b). */
const WIRE_HASHES = {
  "agent-mcp__task": "7596843bb1c154b4730ed8fb68f63950b940d4f2ab6e815b7d65758729f33e07",
  "agent-mcp__tasks_batch": "7ecb5eb049d47b371c203a3b52ec7acd9b6c13c05be4a4ab9f95aca0412d0026",
  "agent-mcp__result": "9338eaea14d7683044af7f2e31c9cab2b4d2a3b9005f645eefb564a9fc8ab0a7",
};
/** Both adapters carry the same schema bytes (the adapters differ only in the envelope key), so one table pins both wires. */
const PINNED: Record<AdapterKind, Record<string, string>> = { anthropic: WIRE_HASHES, openai: WIRE_HASHES };

beforeAll(async () => {
  sc = await startScaffold();
  for (const a of ADAPTERS) {
    sc.setScript(scenario(a), () => ({ text: "nothing to delegate" }));
    const created = await sc.createAgent({ name: `w2-${a}`, adapter: a, scenario: scenario(a), dispatch: true });
    if (created.isError) throw new Error(`agent_create failed: ${textOf(created)}`);
    await sc.runTask(`w2-${a}`, "hello", sc.workDir(scenario(a)));
  }
}, 60_000);

afterAll(async () => {
  expect(sc.leaks, "a request left loopback").toEqual([]);
  await sc?.dispose();
});

describe.each(ADAPTERS)("R10 W2 result descriptor on the real wire [%s]", (a) => {
  const first = (): IModelRequest => {
    const r = sc.requestsFor(scenario(a)).find((x) => x.turn === 0);
    if (!r) throw new Error(`no ${a} request`);
    return r;
  };

  it(`R10 W2 AC1 [${a}]: the model-visible agent-mcp__result description leads with the shared rule (as task and tasks_batch do)`, () => {
    for (const name of ["agent-mcp__task", "agent-mcp__tasks_batch", "agent-mcp__result"]) {
      const d = first().tools.find((t) => t.name === name)?.description;
      expect(d?.startsWith(DELEGATION_DECISION_RULE), `${name}: ${d?.slice(0, 80)}`).toBe(true);
    }
    // the result-specific sentence still follows the rule, so the tool's own purpose is not lost
    expect(first().tools.find((t) => t.name === "agent-mcp__result")?.description).toMatch(/wait_ms/);
  });

  it(`R10 W2 AC2 [${a}]: the input schemas the model sees are unchanged (text-only change)`, () => {
    const got: Record<string, string> = {};
    for (const name of Object.keys(PINNED[a])) got[name] = sha(wireSchema(first(), name));
    expect(got).toEqual(PINNED[a]);
  });
});
