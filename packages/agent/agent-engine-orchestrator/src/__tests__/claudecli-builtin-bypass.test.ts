/**
 * e0d71436-943e-4072-b210-a728cff402fe (G4) - claudecli built-in tools run outside the engine's tool
 * pipeline (hooks/EOL, coercion, result cap, estimator, concurrency pool). Built-ins are default-deny;
 * when an agent opts in, the provider discloses exactly which built-ins are live and what they skip.
 *
 * Spawn-free unit lane: the REAL `ClaudeCliProvider.chat` runs with only `child_process.spawn` mocked.
 *
 * Teeth: removing the `reportBuiltinBypass(request)` call in `chat()` turns AC2 and AC3 red (negative
 * control run when this file was authored).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionAction } from "@adhd/agent-base-types";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";
import type { IBuiltinBypassEvent } from "../providers/claudecli-bypass.js";
import { parseSpecToolsHeader } from "../providers/claudecli-bypass.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
const scratchRoot = mkdtempSync(join(tmpdir(), "e0d71436-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function fakeProc() {
  const stdout = new Readable({ read() {} });
  queueMicrotask(() => { stdout.push(RESULT_LINE + "\n"); stdout.push(null); });
  return { stdout, stdin: { write: () => true, end: () => {} }, stderr: new Readable({ read() {} }), pid: undefined, on: () => {}, kill: () => {}, exitCode: 0, killed: false };
}

const warns: Array<{ obj: unknown; msg: string }> = [];
const logger: EngineLogger = {
  info() {}, error() {}, debug() {},
  warn: ((obj: unknown, msg: string) => { warns.push({ obj, msg }); }) as never,
};
beforeEach(() => { warns.length = 0; });

async function run(opts: { allowed?: string[]; specMd?: string; policy?: (tool: string) => PermissionAction }) {
  const { spawn } = await import("child_process");
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeProc());
  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  const events: IBuiltinBypassEvent[] = [];
  const provider = new ClaudeCliProvider(
    { type: "claudecli", model: "claude-haiku-4-5", ...(opts.allowed ? { allowedBuiltinTools: opts.allowed } : {}), ...(opts.specMd ? { systemPromptIsAgentSpec: true } : {}) } as never,
    {}, undefined,
    { wire: { tempDir: scratchRoot }, server: { contextLimit: 0, defaultMaxTokens: 1 }, subprocessEnv: () => ({}), resolveEnvName: () => undefined } as unknown as EngineConfig,
    logger, undefined,
    { onBuiltinBypass: (e) => events.push(e) },
  );
  const messages = opts.specMd
    ? [{ role: "system", content: opts.specMd }, { role: "user", content: "go" }]
    : [{ role: "user", content: "go" }];
  const req = { messages, ...(opts.policy ? { builtinToolPolicy: opts.policy } : {}) } as unknown as ProviderChatRequest;
  await provider.chat(req);
  const args = spawnMock.mock.calls[0]?.[1] as string[];
  return { args, events, bypassWarns: warns.filter((w) => w.msg.startsWith("provider:builtin_bypass")) };
}

describe("e0d71436 AC1: default agent has no built-ins and no bypass warning", () => {
  it("e0d71436-943e-4072-b210-a728cff402fe AC1: no allowedBuiltinTools -> --tools \"\" and zero bypass events/warnings", async () => {
    const r = await run({});
    expect(r.args[r.args.indexOf("--tools") + 1]).toBe("");
    expect(r.events).toEqual([]);
    expect(r.bypassWarns).toEqual([]);
  });
});

describe("e0d71436 AC2: opt-in built-ins are disclosed", () => {
  it("e0d71436-943e-4072-b210-a728cff402fe AC2: allowedBuiltinTools [Edit,Bash] -> one event naming both and every skipped behaviour", async () => {
    const r = await run({ allowed: ["Edit", "Bash"] });
    expect(r.args[r.args.indexOf("--tools") + 1]).toBe("Edit,Bash");
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.event).toBe("provider:builtin_bypass");
    expect(e.source).toBe("allowedBuiltinTools");
    expect(e.builtins).toEqual(["Edit", "Bash"]);
    const skipped = e.skipped.join(" | ");
    for (const needle of [/hooks/, /EOL/, /coercion/, /cap/, /estimator/, /pool/]) expect(skipped).toMatch(needle);
    expect(r.bypassWarns).toHaveLength(1);
  });

  it("e0d71436-943e-4072-b210-a728cff402fe AC2: a built-in withheld by a non-allow verdict is not listed", async () => {
    const r = await run({ allowed: ["Edit", "Bash"], policy: (t) => (t === "Bash" ? "deny" : "allow") });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.builtins).toEqual(["Edit"]);
  });

  it("e0d71436-943e-4072-b210-a728cff402fe AC2: every requested built-in withheld -> no event (nothing is live)", async () => {
    const r = await run({ allowed: ["Bash"], policy: () => "ask" });
    expect(r.events).toEqual([]);
  });
});

describe("e0d71436 AC3: agent-spec mode", () => {
  it("e0d71436-943e-4072-b210-a728cff402fe AC3: spec `tools:` header -> event with source agent-spec naming the header's tools", async () => {
    const r = await run({ specMd: "---\nname: s\ndescription: d\ntools: Bash, Edit\n---\nbody" });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.source).toBe("agent-spec");
    expect(r.events[0]!.builtins).toEqual(["Bash", "Edit"]);
  });

  it("e0d71436-943e-4072-b210-a728cff402fe AC3: spec without a `tools:` header inherits everything -> builtins ['*']", async () => {
    const r = await run({ specMd: "---\nname: s\ndescription: d\n---\nbody" });
    expect(r.events[0]!.source).toBe("agent-spec");
    expect(r.events[0]!.builtins).toEqual(["*"]);
  });

  it("e0d71436-943e-4072-b210-a728cff402fe AC3: parseSpecToolsHeader handles list/quoted/CRLF forms", () => {
    expect(parseSpecToolsHeader("---\r\nname: s\r\ntools: [Read, \"Write\"]\r\n---\r\nb")).toEqual(["Read", "Write"]);
    expect(parseSpecToolsHeader("no front matter")).toBeUndefined();
  });
});
