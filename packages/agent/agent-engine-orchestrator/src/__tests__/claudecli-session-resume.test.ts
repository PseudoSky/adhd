/**
 * b31e1fe5 (R3-COST) -- claudecli session continuity: a follow-up task on the same engine session resumes the
 * retained CLI session (forked, tail only) instead of replaying the whole history cold. The real
 * ClaudeCliProvider and the real session registry run; only `child_process.spawn` is replaced (no model call).
 * The measured effect on a real model lives in claudecli-phase2-cache.e2e.test.ts.
 *
 *  AC1 (argv/stdin half)  the second task is `--resume <parent> --fork-session` and sends ONLY the new message
 *  AC3                     everything that cannot be proven covered falls back to the unchanged text replay
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { ClaudeCliSessionRegistry, messageFingerprint } from "../providers/claudecli-session.js";
import type { ProviderChatRequest } from "../providers/types.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), "b31e1fe5-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const configDir = join(root, "claude-config");

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const engineConfig = {
  wire: { tempDir: root },
  cwd: root,
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "" },
  plugins: { entries: [] },
  getProviderConfig: () => ({}),
  subprocessEnv: () => ({ CLAUDE_CONFIG_DIR: configDir }),
  resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;

const ok = (text: string, sessionId?: string): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, ...(sessionId ? { session_id: sessionId } : {}) });
const notFound = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: x"] });

interface ISpawned { args: string[]; stdin: string[] }
const spawned: ISpawned[] = [];
let scripts: string[][] = [];

async function arm(): Promise<void> {
  const { spawn } = await import("child_process");
  (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation((_bin: string, args: string[]) => {
    const lines = scripts.shift() ?? [ok("OK")];
    const stdout = new Readable({ read() {} });
    const rec: ISpawned = { args, stdin: [] };
    spawned.push(rec);
    queueMicrotask(() => { for (const l of lines) stdout.push(l + "\n"); stdout.push(null); });
    return {
      stdout, stderr: new Readable({ read() {} }), pid: undefined, on: () => {}, kill: () => {}, exitCode: 0, killed: false,
      stdin: { write: (s: string) => { rec.stdin.push(s); return true; }, end: () => {} },
    };
  });
}

const stdinText = (r: ISpawned): string => (JSON.parse(r.stdin[0]!) as { message: { content: string } }).message.content;
const user = (content: string) => ({ role: "user", content }) as ProviderChatRequest["messages"][number];
const assistant = (content: string) => ({ role: "assistant", content }) as ProviderChatRequest["messages"][number];
const system = (content: string) => ({ role: "system", content }) as ProviderChatRequest["messages"][number];

async function provider(sessionKey: string | undefined, sessions: ClaudeCliSessionRegistry, providerConfig: Record<string, unknown> = {}) {
  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  return new ClaudeCliProvider({ type: "claudecli", model: "claude-haiku-4-5", ...providerConfig } as never, {}, undefined, engineConfig, logger, undefined, { sessionKey, sessions });
}
const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

beforeEach(async () => { spawned.length = 0; scripts = []; await arm(); });

describe("b31e1fe5 AC1: a follow-up task resumes the retained CLI session", () => {
  it("task 1 pins a session id and persists; task 2 forks it and sends only the new message", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    scripts = [[ok("first answer", "child-1")], [ok("second answer", "child-2")]];

    await (await provider("S", sessions)).chat({ messages: [system("be terse"), user("task one")] });
    const t1 = spawned[0]!;
    expect(t1.args).not.toContain("--no-session-persistence");
    const pinned = after(t1.args, "--session-id");
    expect(pinned).toMatch(/^[0-9a-f-]{36}$/);

    await (await provider("S", sessions)).chat({
      messages: [system("be terse"), user("task one"), assistant("first answer"), user("task two")],
    });
    const t2 = spawned[1]!;
    expect(after(t2.args, "--resume")).toBe("child-1");
    expect(t2.args).toContain("--fork-session");
    expect(t2.args).not.toContain("--session-id");
    expect(t2.args).not.toContain("--no-session-persistence");
    expect(stdinText(t2)).toBe("task two"); // not "[Conversation history] ... task one ..."

    // the chain continues from the fork's own id, not the original
    await (await provider("S", sessions)).chat({
      messages: [system("be terse"), user("task one"), assistant("first answer"), user("task two"), assistant("second answer"), user("task three")],
    });
    expect(after(spawned[2]!.args, "--resume")).toBe("child-2");
    expect(stdinText(spawned[2]!)).toBe("task three");
    sessions.releaseAll();
  });

  it("two sessions never share a CLI session (ADR-0012: unique ids per agent session)", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    await (await provider("A", sessions)).chat({ messages: [user("hi")] });
    await (await provider("B", sessions)).chat({ messages: [user("hi")] });
    expect(after(spawned[0]!.args, "--session-id")).not.toBe(after(spawned[1]!.args, "--session-id"));
    sessions.releaseAll();
  });
});

describe("b31e1fe5 AC3: anything not provably covered falls back to the text replay", () => {
  const history = [system("be terse"), user("task one"), assistant("first answer"), user("task two")];

  async function afterFirstTask(sessions: ClaudeCliSessionRegistry): Promise<void> {
    scripts = [[ok("first answer", "child-1")]];
    await (await provider("S", sessions)).chat({ messages: [system("be terse"), user("task one")] });
    spawned.length = 0;
  }
  const expectReplay = (r: ISpawned): void => {
    expect(r.args).not.toContain("--resume");
    expect(stdinText(r)).toContain("[Conversation history]");
    expect(stdinText(r)).toContain("task one");
  };

  it("edited / compacted history", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    await afterFirstTask(sessions);
    await (await provider("S", sessions)).chat({ messages: [system("be terse"), user("task one (compacted)"), assistant("first answer"), user("task two")] });
    expect(spawned[0]!.args).not.toContain("--resume");
    sessions.releaseAll();
  });

  it("a changed system prompt or model", async () => {
    for (const change of ["system", "model"] as const) {
      const sessions = new ClaudeCliSessionRegistry();
      await afterFirstTask(sessions);
      const msgs = change === "system" ? [system("be verbose"), ...history.slice(1)] : history;
      await (await provider("S", sessions, change === "model" ? { model: "claude-sonnet-4-6" } : {})).chat({ messages: msgs });
      expectReplay(spawned[0]!);
      sessions.releaseAll();
    }
  });

  it("no engine session: original --no-session-persistence, no resume", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    await (await provider(undefined, sessions)).chat({ messages: history });
    expect(spawned[0]!.args).toContain("--no-session-persistence");
    expectReplay(spawned[0]!);
    expect(sessions.size).toBe(0);
  });

  it("resumeSession:false and keepSessionTranscript keep the original behaviour", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    await (await provider("S", sessions, { resumeSession: false })).chat({ messages: history });
    expect(spawned[0]!.args).toContain("--no-session-persistence");
    await (await provider("S", sessions, { keepSessionTranscript: true })).chat({ messages: history });
    expect(spawned[1]!.args).not.toContain("--no-session-persistence");
    expect(spawned[1]!.args).not.toContain("--session-id");
    expect(sessions.size).toBe(0);
  });

  it("a resume the CLI cannot find is retried once as a full text replay", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    await afterFirstTask(sessions);
    scripts = [[notFound], [ok("second answer", "child-2")]];
    const res = await (await provider("S", sessions)).chat({ messages: history });
    expect(res.message.content).toBe("second answer");
    expect(spawned).toHaveLength(2);
    expect(after(spawned[0]!.args, "--resume")).toBe("child-1");
    expectReplay(spawned[1]!);
    expect(spawned[1]!.args).toContain("--session-id");
    sessions.releaseAll();
  });

  it("a failed run does not advance the resumable head", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    await afterFirstTask(sessions);
    scripts = [[JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "boom" })]];
    await expect((await provider("S", sessions)).chat({ messages: history })).rejects.toThrow();
    spawned.length = 0;
    scripts = [[ok("second answer", "child-2")]];
    await (await provider("S", sessions)).chat({ messages: history });
    expect(after(spawned[0]!.args, "--resume")).toBe("child-1"); // still the last good transcript
    sessions.releaseAll();
  });
});

describe("b31e1fe5: retained transcripts are not a leak", () => {
  function transcript(id: string): string {
    const dir = join(configDir, "projects", "-some-cwd");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, "{}\n");
    return file;
  }

  it("release() deletes every transcript the session created", async () => {
    const sessions = new ClaudeCliSessionRegistry();
    scripts = [[ok("a", "child-1")]];
    await (await provider("S", sessions)).chat({ messages: [user("hi")] });
    const pinned = after(spawned[0]!.args, "--session-id")!;
    const files = [transcript(pinned), transcript("child-1")];
    sessions.release("S");
    for (const f of files) expect(existsSync(f)).toBe(false);
    expect(sessions.size).toBe(0);
  });

  it("LRU eviction and the idle TTL release old sessions", () => {
    let t = 0;
    const s = new ClaudeCliSessionRegistry(() => t, { idleTtlMs: 100, maxRetained: 2 });
    const commit = (key: string, id: string): void => s.commit(key, { configKey: "k", configDir, cliSessionId: id, nonSystem: [user("x")], reply: "y" });
    const files = ["e1", "e2", "e3"].map(transcript);
    commit("one", "e1"); t = 1; commit("two", "e2"); t = 2; commit("three", "e3");
    expect(s.size).toBe(2);
    expect(existsSync(files[0]!)).toBe(false); // oldest evicted, transcript removed
    t = 500; // idle past the TTL
    s.plan("two", "k", configDir, [user("x"), assistant("y"), user("z")]);
    expect(existsSync(files[1]!)).toBe(false);
    s.releaseAll();
  });

  it("fingerprints are role+text only (tool traces are CLI-internal)", () => {
    expect(messageFingerprint({ role: "assistant", content: "a" })).toBe(
      messageFingerprint({ role: "assistant", content: "a", toolResults: [{}] } as never),
    );
    expect(messageFingerprint({ role: "assistant", content: "a" })).not.toBe(messageFingerprint({ role: "user", content: "a" }));
  });
});
