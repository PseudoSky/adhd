/**
 * e0d71436-943e-4072-b210-a728cff402fe (G4) - claudecli built-in tools run outside the engine's tool
 * pipeline (hooks/EOL, coercion, result cap, estimator, concurrency pool). Built-ins are default-deny;
 * when an agent opts in, the provider discloses exactly which built-ins are live and what they skip.
 *
 * Spawn-free unit lane: the REAL `ClaudeCliProvider.chat` runs with only `child_process.spawn` mocked.
 *
 * Teeth: every positive case asserts the event/warn that only `reportBuiltinBypass(request)` in `chat()`
 * produces (and AC1 asserts its absence for default-deny), so removing that call turns AC2 and AC3 red.
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
const debugs: Array<{ obj: unknown; msg: string }> = [];
const logger: EngineLogger = {
  info() {}, error() {},
  debug: ((obj: unknown, msg: string) => { debugs.push({ obj, msg }); }) as never,
  warn: ((obj: unknown, msg: string) => { warns.push({ obj, msg }); }) as never,
};
beforeEach(() => { warns.length = 0; debugs.length = 0; });

async function run(opts: { allowed?: string[]; specMd?: string; policy?: (tool: string) => PermissionAction; chats?: number; onBypass?: (e: IBuiltinBypassEvent) => void }) {
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
    { onBuiltinBypass: (e) => { events.push(e); opts.onBypass?.(e); } },
  );
  const messages = opts.specMd
    ? [{ role: "system", content: opts.specMd }, { role: "user", content: "go" }]
    : [{ role: "user", content: "go" }];
  const req = { messages, ...(opts.policy ? { builtinToolPolicy: opts.policy } : {}) } as unknown as ProviderChatRequest;
  for (let i = 0; i < (opts.chats ?? 1); i += 1) {
    spawnMock.mockReturnValue(fakeProc());
    await provider.chat(req);
  }
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

describe("e0d71436 review-M2: the disclosure is once per task, not once per model turn", () => {
  it("e0d71436 review-M2: three chat() calls on one provider -> one event and one warn", async () => {
    const r = await run({ allowed: ["Edit", "Bash"], chats: 3 });
    expect(r.events).toHaveLength(1);
    expect(r.bypassWarns).toHaveLength(1);
  });

  it("e0d71436 review-L5: a throwing onBuiltinBypass callback never fails chat() and is logged, not swallowed silently", async () => {
    const r = await run({ allowed: ["Edit"], onBypass: () => { throw new Error("sink down"); } });
    expect(r.args).toBeDefined(); // chat() completed
    expect(debugs.some((d) => d.msg.includes("built-in bypass disclosure failed"))).toBe(true);
  });
});

describe("e0d71436 AC3: agent-spec mode", () => {
  it("e0d71436-943e-4072-b210-a728cff402fe AC3: spec `tools:` header -> event with source agent-spec naming the header's tools", async () => {
    const r = await run({ specMd: "---\nname: s\ndescription: d\ntools: Bash, Edit\n---\nbody" });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.source).toBe("agent-spec");
    expect(r.events[0]!.builtins).toEqual(["Bash", "Edit"]);
  });

  it("cf7e0e5c review-5: agent-spec mode never lists a header built-in the permission gate withheld", async () => {
    // `GatedTool` is outside KNOWN_CLAUDE_BUILTINS, so the spec-mode governance refusal does not fire; only the filter hides it.
    const policy = (tool: string): PermissionAction => (tool === "GatedTool" ? "deny" : "allow");
    const r = await run({ specMd: "---\nname: s\ndescription: d\ntools: Bash, GatedTool\n---\nbody", policy });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.builtins).toEqual(["Bash"]);
    expect(JSON.stringify(r.bypassWarns)).not.toContain("GatedTool");
  });

  it("cf7e0e5c review-5: agent-spec header whose every built-in is withheld discloses nothing", async () => {
    const policy = (tool: string): PermissionAction => (tool === "GatedTool" ? "ask" : "allow");
    const r = await run({ specMd: "---\nname: s\ndescription: d\ntools: GatedTool\n---\nbody", policy });
    expect(r.events).toEqual([]);
    expect(r.bypassWarns).toEqual([]);
  });

  it("e0d71436-943e-4072-b210-a728cff402fe AC3: spec without a `tools:` header inherits everything -> builtins ['*']", async () => {
    const r = await run({ specMd: "---\nname: s\ndescription: d\n---\nbody" });
    expect(r.events[0]!.source).toBe("agent-spec");
    expect(r.events[0]!.builtins).toEqual(["*"]);
  });

  it("e0d71436 review-M1: block-style `tools:` list is disclosed (previously parsed as [] -> silently no warning)", async () => {
    const r = await run({ specMd: "---\nname: s\ndescription: d\ntools:\n  - Bash\n  - \"Edit\"\n---\nbody" });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.builtins).toEqual(["Bash", "Edit"]);
    expect(r.bypassWarns).toHaveLength(1);
  });

  it("e0d71436 review-M1: an explicitly empty header (`tools: []`) discloses nothing", async () => {
    const r = await run({ specMd: "---\nname: s\ndescription: d\ntools: []\n---\nbody" });
    expect(r.events).toEqual([]);
  });

  it("e0d71436 review-M1/L6: parseSpecToolsHeader block lists (LF + CRLF), explicit empties, column-0 anchoring", () => {
    expect(parseSpecToolsHeader("---\nname: s\ntools:\n  - Bash\n  - Edit # note\n\n  - Read\nmodel: x\n---\nb")).toEqual(["Bash", "Edit", "Read"]);
    expect(parseSpecToolsHeader("---\r\nname: s\r\ntools:\r\n  - Bash\r\n  - Edit\r\n---\r\nb")).toEqual(["Bash", "Edit"]);
    expect(parseSpecToolsHeader("---\ntools: []\n---\nb")).toEqual([]);
    expect(parseSpecToolsHeader("---\ntools: \"\"\n---\nb")).toEqual([]);
    // A bare `tools:` is YAML null, not an empty list: treated as an absent header (inherit everything).
    expect(parseSpecToolsHeader("---\nname: s\ntools:\nmodel: x\n---\nb")).toBeUndefined();
    // An indented `tools:` inside a block scalar is not the header.
    expect(parseSpecToolsHeader("---\ndescription: |\n  tools: Bash\nname: s\n---\nb")).toBeUndefined();
  });

  it("e0d71436-943e-4072-b210-a728cff402fe AC3: parseSpecToolsHeader handles list/quoted/CRLF forms", () => {
    expect(parseSpecToolsHeader("---\r\nname: s\r\ntools: [Read, \"Write\"]\r\n---\r\nb")).toEqual(["Read", "Write"]);
    expect(parseSpecToolsHeader("no front matter")).toBeUndefined();
  });
});
