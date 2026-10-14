/**
 * R10 S4 (P3 fs write/edit note, P4 shell rejection recovery, P6a-adjacent hook wiring) -- the notes the host
 * adds to what the MODEL sees of a tool result.
 *
 * Real components, no mocks of the thing under test: the real `Orchestrator`, the real host hook registry
 * (`createHostHooks`, the seam `main()` uses), a real `TaskStore` on a sqlite built through the shipped
 * migrations, the real native-tooling resolver for the agent's `fs` / `shell` server configs. Only the LLM
 * boundary (the provider) and the MCP client boundary (what `fs` / `shell` return) are scripted.
 *
 * What is observed, per scenario:
 *   - the messages the provider RECEIVES on its second call (the model-visible request),
 *   - the messages the session store PERSISTED (serialized at `appendMessage` time, like a DB write),
 *   - the `post:tool_call` payload and the `message:appended` payload an embedder sees,
 *   - the `TOOL_RESULT` task event.
 *
 * Teeth: every positive case has a control that differs in exactly one input (dryRun, error, custom `fs`, no
 * host hooks), and the mutants listed in the segment report (note on dryRun; note in history; a diverged
 * allowlist) each turn a named test here red.
 *
 * guards: the fs write/edit note is appended on a dryRun, an error, a custom `fs` server or another tool, or reaches history and
 *   observers; the shell recovery note names a runner outside the allowlist or touches a non-rejection; the allowlist widens.
 * tier: S (in-process real Orchestrator, host hooks and sqlite store with a scripted provider and MCP client; no process)
 * cites: R10 S4 AC1, AC2, AC3, AC6 (this file names no backlog uid).
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ExecutionContext, McpServerConfig, Message } from "@adhd/agent-base-types";
import { DEFAULT_SHELL_ALLOW_COMMANDS } from "@adhd/agent-core-native-tooling";
import { HookRegistry, SHELL_UNAVAILABLE_COMMANDS, shellRejectionNote } from "@adhd/agent-engine-orchestrator";

import {
  FS_EDIT_NOTE,
  FS_WRITE_NOTE,
  isCatalogFsServer,
  noteFor,
  registerToolResultNotes,
  withNote,
} from "../tool-result-notes.js";
import { catalogServers, customFs, openDbs, runCall, sandboxedServers, scratch } from "./r10-s4-harness.js";

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const toolResultOf = (msgs: Message[]): unknown => msgs.find((m) => m.role === "tool")?.toolResults?.[0]?.result;
const textOf = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
const WROTE = [{ type: "text", text: "Successfully wrote to /w/a.txt" }];
const DIFF = [{ type: "text", text: "```diff\n--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n```" }];

describe("R10 S4 AC1: the fs note is appended on a catalog-fs success and nowhere else", () => {
  it("R10 S4 AC1: a successful fs__write_file by the catalog server gets the write note in the model's request", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: WROTE });
    expect(toolResultOf(run.secondRequest)).toEqual([...WROTE, { type: "text", text: FS_WRITE_NOTE }]);
  });

  it("R10 S4 AC1: the same holds when the catalog fs server runs under the srt sandbox wrapper", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: WROTE, mcpServers: sandboxedServers() });
    expect(textOf(toolResultOf(run.secondRequest))).toContain(FS_WRITE_NOTE);
  });

  it("R10 S4 AC1: a successful fs__edit_file (not a dry run) gets the edit note", async () => {
    const run = await runCall({ server: "fs", tool: "edit_file", args: { path: "/w/a.txt", edits: [] }, returns: DIFF });
    expect(toolResultOf(run.secondRequest)).toEqual([...DIFF, { type: "text", text: FS_EDIT_NOTE }]);
  });

  it("R10 S4 AC1: NO note on a dryRun edit -- the request carries the server's exact diff and claims nothing was applied", async () => {
    const run = await runCall({ server: "fs", tool: "edit_file", args: { path: "/w/a.txt", edits: [], dryRun: true }, returns: DIFF });
    expect(toolResultOf(run.secondRequest)).toEqual(DIFF);
    expect(textOf(toolResultOf(run.secondRequest))).not.toMatch(/applied|written/);
  });

  it("R10 S4 AC1: NO note when dryRun arrives as the string 'true' (anything not clearly false is a preview)", async () => {
    const run = await runCall({ server: "fs", tool: "edit_file", args: { path: "/w/a.txt", edits: [], dryRun: "true" }, returns: DIFF });
    expect(toolResultOf(run.secondRequest)).toEqual(DIFF);
  });

  it("R10 S4 AC1: NO note on an error result", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: "ENOENT: no such directory", throws: true });
    expect(textOf(toolResultOf(run.secondRequest))).not.toContain("[Note:");
    expect(textOf(toolResultOf(run.secondRequest))).toContain("ENOENT");
  });

  it("R10 S4 AC1: NO note when `fs` is a custom server that replaced the builtin (it merely shares the name)", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: WROTE, mcpServers: { fs: customFs } });
    expect(toolResultOf(run.secondRequest)).toEqual(WROTE);
  });

  it("R10 S4 AC1: NO note when the agent has no `fs` server config at all (fails closed)", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: WROTE, mcpServers: {} });
    expect(toolResultOf(run.secondRequest)).toEqual(WROTE);
  });

  it("R10 S4 AC1: NO note for any other fs tool (read_text_file)", async () => {
    const run = await runCall({ server: "fs", tool: "read_text_file", args: { path: "/w/a.txt" }, returns: [{ type: "text", text: "hello" }] });
    expect(toolResultOf(run.secondRequest)).toEqual([{ type: "text", text: "hello" }]);
  });

  it("R10 S4 AC1 (control): without the host hooks the identical write carries no note", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: WROTE, hostHooks: false });
    expect(toolResultOf(run.secondRequest)).toEqual(WROTE);
  });

  it("R10 S4 AC1: the note is stable across turns (the same text again on a later request of the same run)", async () => {
    // A second request of the same run re-applies the remembered note exactly once (idempotent).
    const hooks = new HookRegistry();
    registerToolResultNotes(hooks, { isCatalogFs: () => true });
    await hooks.emit("post:tool_call", { executionContext: {} as never, toolName: "fs__write_file", callId: "c1", toolInput: {}, result: WROTE, isError: false, estResultTokens: 0 });
    const msgs: Message[] = [{ id: "m", sessionId: "s", role: "tool", toolResults: [{ toolCallId: "c1", result: WROTE, isError: false }], createdAt: "t" }];
    await hooks.enforce("pre:model_request", { executionContext: {} as never, messages: msgs, tools: [] });
    await hooks.enforce("pre:model_request", { executionContext: {} as never, messages: msgs, tools: [] });
    expect(JSON.stringify(msgs).split(FS_WRITE_NOTE).length - 1).toBe(1);
  });
});

describe("R10 S4 AC2: the note never reaches stored history nor anything an embedder observes", () => {
  it("R10 S4 AC2: history, post:tool_call, message:appended, the observational pre:model_request payload and TOOL_RESULT carry the server's exact text", async () => {
    const run = await runCall({ server: "fs", tool: "write_file", args: { path: "/w/a.txt", content: "x" }, returns: WROTE });
    // Teeth: the model DID get the note in this very run.
    expect(textOf(toolResultOf(run.secondRequest))).toContain(FS_WRITE_NOTE);
    // The persisted tool message is the server's text, byte for byte.
    const toolMsg = run.stored.map((s) => JSON.parse(s) as Message).find((m) => m.role === "tool");
    expect(toolMsg?.toolResults?.[0]?.result).toEqual(WROTE);
    for (const s of run.stored) expect(s).not.toContain("[Note:");
    for (const s of run.appended) expect(s).not.toContain("[Note:");
    expect(run.observedRequest).not.toContain("[Note:");
    expect(run.toolResultEvent).not.toContain("[Note:");
    expect(run.postPayloads).toHaveLength(1);
    expect(run.postPayloads[0].result).toEqual(WROTE);
    // The trace signal says a note was added for this call.
    expect(run.postPayloads[0].noteAppended).toBe(true);
  });

  it("R10 S4 AC2: no noteAppended signal when no note applies (dryRun)", async () => {
    const run = await runCall({ server: "fs", tool: "edit_file", args: { path: "/w/a.txt", edits: [], dryRun: true }, returns: DIFF });
    expect(run.postPayloads[0].noteAppended).toBeUndefined();
  });

  it("R10 S4 AC2: the persisted message object is never mutated (the request carries a copy)", async () => {
    const hooks = new HookRegistry();
    registerToolResultNotes(hooks, { isCatalogFs: () => true });
    const original: Message = { id: "m", sessionId: "s", role: "tool", toolResults: [{ toolCallId: "c1", result: WROTE, isError: false }], createdAt: "t" };
    const before = JSON.stringify(original);
    await hooks.emit("post:tool_call", { executionContext: {} as never, toolName: "fs__write_file", callId: "c1", toolInput: {}, result: WROTE, isError: false, estResultTokens: 0 });
    const request = [original];
    await hooks.enforce("pre:model_request", { executionContext: {} as never, messages: request, tools: [] });
    expect(JSON.stringify(original)).toBe(before);
    expect(request[0]).not.toBe(original);
    expect(JSON.stringify(request[0])).toContain(FS_WRITE_NOTE);
  });
});

describe("R10 S4 AC3: the shell policy rejection carries an actionable, un-fitted recovery line", () => {
  const REJECTION =
    "Tool 'shell_execute' on server 'shell' returned an error: [{\"type\":\"text\",\"text\":\"Command rejected by default security policy: node\"}]";

  it("R10 S4 AC3: a rejected `node` names the policy, the command, the fs tools and an allowed runner, and no fixture command", async () => {
    const run = await runCall({ server: "shell", tool: "shell_execute", args: { command: ["node", "-e", "1"] }, returns: REJECTION, throws: true });
    const seen = textOf(toolResultOf(run.secondRequest));
    expect(seen).toContain("Command rejected by default security policy"); // the server's own text is kept
    expect(seen).toContain("[Note:");
    expect(seen).toMatch(/default security policy, which never runs/);
    expect(seen).toContain('"node"');
    expect(seen).toContain("fs__edit_file");
    expect(seen).toMatch(/allowed runner \(npm, pnpm, npx, nx, make, uv\)/);
    for (const c of SHELL_UNAVAILABLE_COMMANDS) expect(seen).toContain(c);
    // No fixture-fitted advice: no concrete script or target is named.
    expect(seen).not.toMatch(/make test|npm test|npm run|pnpm test|node --test|npx vitest|node -e/);
    // And it is not written to history.
    for (const s of run.stored) expect(s).not.toContain("[Note:");
  });

  it("R10 S4 AC3: shellRejectionNote only names runners the allowlist actually contains", () => {
    expect(shellRejectionNote("sed", ["cat", "ls"])).not.toMatch(/runner/);
    expect(shellRejectionNote("sed", ["npm", "cat"])).toContain("(npm)");
    expect(shellRejectionNote(undefined)).toMatch(/^That command is rejected by the shell server's default security policy/);
    // cafe9a17 AC1: no effective config -> no runner is suggested (the catalog default is never assumed).
    expect(shellRejectionNote("node")).not.toMatch(/runner/);
    expect(shellRejectionNote("node", DEFAULT_SHELL_ALLOW_COMMANDS)).toContain("allowed runner (npm, pnpm, npx, nx, make, uv)");
  });

  it("R10 S4 AC3: a different shell error (not a policy rejection) is untouched", async () => {
    const run = await runCall({ server: "shell", tool: "shell_execute", args: { command: ["ls", "/nope"] }, returns: "Tool 'shell_execute' on server 'shell' returned an error: No such file", throws: true });
    expect(textOf(toolResultOf(run.secondRequest))).not.toContain("[Note:");
  });

  it("R10 S4 AC3: a successful shell result is untouched even if its output mentions the rejection phrase", async () => {
    const run = await runCall({ server: "shell", tool: "shell_execute", args: { command: ["echo", "x"] }, returns: [{ type: "text", text: "Command rejected by default security policy: x" }] });
    expect(toolResultOf(run.secondRequest)).toEqual([{ type: "text", text: "Command rejected by default security policy: x" }]);
  });

  it("R10 S4 AC3: the rejection note goes only to shell__shell_execute (the same text from another tool is untouched)", () => {
    expect(noteFor({ executionContext: {} as never, toolName: "other__tool", toolInput: {}, result: REJECTION, isError: true })).toBeUndefined();
  });
});

describe("R10 S4 AC6: the shell allowlist is byte-identical", () => {
  const EXPECTED = [
    "cat", "ls", "cp", "mv", "mkdir", "rm", "touch", "head", "tail", "wc", "sort", "uniq", "tr", "cut", "diff", "awk",
    "grep", "rg", "echo", "printf", "pwd", "test", "true", "false", "basename", "dirname", "realpath", "stat", "tee",
    "chmod", "git", "npm", "pnpm", "npx", "nx", "make", "tsc", "uv", "curl",
  ];

  it("R10 S4 AC6: DEFAULT_SHELL_ALLOW_COMMANDS equals the pinned list and widens nothing", () => {
    expect([...DEFAULT_SHELL_ALLOW_COMMANDS]).toEqual(EXPECTED);
    for (const c of SHELL_UNAVAILABLE_COMMANDS) expect(DEFAULT_SHELL_ALLOW_COMMANDS).not.toContain(c);
  });

  it("R10 S4 AC6: the resolver still emits exactly that list as the shell server's ALLOW_COMMANDS", () => {
    const shell = catalogServers()["shell"] as { env?: Record<string, string> };
    expect(shell.env?.["ALLOW_COMMANDS"]).toBe(EXPECTED.join(","));
  });

  it("R10 S4 AC6: the catalog.ts allowlist declaration is unchanged (source-level pin)", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/agent/agent-core-native-tooling/src/lib/catalog.ts"), "utf8");
    const block = /export const DEFAULT_SHELL_ALLOW_COMMANDS[\s\S]*?\]\);/.exec(src)?.[0] ?? "";
    expect(block.length).toBeGreaterThan(100);
    expect(createHash("sha256").update(block).digest("hex")).toBe("9ac41882cd4539933e1b8cec21ac56960bb37728107403c46f3a874c197c3b92");
  });
});

describe("R10 S4: helper contracts", () => {
  it("withNote handles strings, content arrays and { content } objects, is idempotent, and never mutates", () => {
    const arr = [{ type: "text", text: "a" }];
    expect(withNote("a", "N")).toBe("a\n\nN");
    expect(withNote(withNote("a", "N"), "N")).toBeUndefined();
    expect(withNote(arr, "N")).toEqual([...arr, { type: "text", text: "N" }]);
    expect(arr).toHaveLength(1);
    expect(withNote({ content: arr, isError: false }, "N")).toEqual({ content: [...arr, { type: "text", text: "N" }], isError: false });
    expect(withNote(42, "N")).toBeUndefined();
    expect(withNote({ other: 1 }, "N")).toBeUndefined();
  });

  it("isCatalogFsServer is true for the resolved catalog fs config (plain and sandboxed) and false otherwise", () => {
    const mk = (mcpServers: Record<string, McpServerConfig>) => ({ agentDefinition: { mcpServers } }) as unknown as ExecutionContext;
    expect(isCatalogFsServer(mk(catalogServers()))).toBe(true);
    expect(isCatalogFsServer(mk(sandboxedServers()))).toBe(true);
    expect(isCatalogFsServer(mk({ fs: customFs }))).toBe(false);
    expect(isCatalogFsServer(mk({}))).toBe(false);
    expect(isCatalogFsServer({} as ExecutionContext)).toBe(false);
  });

  it("the remembered-note map is bounded (oldest evicted first)", async () => {
    const hooks = new HookRegistry();
    const handle = registerToolResultNotes(hooks, { maxEntries: 2, isCatalogFs: () => true });
    for (const id of ["a", "b", "c"]) {
      await hooks.emit("post:tool_call", { executionContext: {} as never, toolName: "fs__write_file", callId: id, toolInput: {}, result: WROTE, isError: false, estResultTokens: 0 });
    }
    expect(handle.size()).toBe(2);
  });
});
