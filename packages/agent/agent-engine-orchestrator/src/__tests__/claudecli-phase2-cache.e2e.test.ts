/**
 * b31e1fe5 (R3-COST) AC1 -- a second task on the same agent session must hit the prompt cache for what the first
 * task already wrote, instead of re-writing the whole conversation cold.
 *
 * Real `claude` binary, real model (claude-haiku-4-5, ~6k-token first prompt, one-word replies, 2 calls), real
 * `ClaudeCliProvider` and the real session registry; nothing is mocked. The number asserted is the consumer-visible
 * one the CLI itself reports on the task's result usage: first-turn `cache_read_input_tokens` over first-turn context.
 *
 * Gate: none. This runs by default in the e2e lane. A missing `claude` binary FAILS the suite (never skips).
 *
 * Measured baseline (spike, claude 2.1.x, same prompts, text replay + `--no-session-persistence`, the behaviour
 * before this change): ratio 0.00, cache_creation 1h 6,312 tokens (everything re-written cold). With the retained
 * session: ratio 0.98, cache_creation 1h 121 tokens (-98%). This test fails if the ratio drops below 0.6.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { ClaudeCliProvider } from "../providers/claudecli.js";
import { ClaudeCliSessionRegistry } from "../providers/claudecli-session.js";
import type { Message } from "../validation/index.js";

const scratch = mkdtempSync(join(tmpdir(), "b31e1fe5-e2e-"));
const sessions = new ClaudeCliSessionRegistry();
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const engineConfig = {
  wire: { tempDir: scratch },
  cwd: scratch,
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "" },
  plugins: { entries: [] },
  getProviderConfig: () => ({}),
  subprocessEnv: () => ({}),
  resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;

/** Deterministic, non-repeating filler (a linear congruential walk over a word list) so the prompt is ~5-6k tokens. */
function filler(words: number): string {
  const vocab = ["alpha", "river", "stone", "lumen", "forge", "delta", "quartz", "maple", "ember", "cobalt"];
  let x = 12345;
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(`${vocab[x % 10]}${x % 977}`);
  }
  return out.join(" ");
}

const msg = (role: Message["role"], content: string): Message =>
  ({ id: crypto.randomUUID(), sessionId: crypto.randomUUID(), role, content, createdAt: new Date().toISOString() });

interface IUsage { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } }
const context = (u: IUsage): number => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

beforeAll(() => {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`b31e1fe5: the \`claude\` binary is required for this e2e test (exit ${String(probe.status)}): ${probe.stderr}`);
});

afterAll(() => {
  sessions.releaseAll(); // deletes every retained transcript this test created
  const projectDir = join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects", scratch.replace(/[^a-zA-Z0-9]/g, "-"));
  if (existsSync(projectDir) && readdirSync(projectDir).length === 0) rmdirSync(projectDir);
  rmSync(scratch, { recursive: true, force: true });
});

describe("b31e1fe5 AC1 (R3-COST): the second task on a session reads the first task's prefix from cache", () => {
  it("b31e1fe5 AC1: first-turn cache_read / first-turn context >= 0.6 and the 1h write drops by more than half", async () => {
    const provider = () => new ClaudeCliProvider(
      { type: "claudecli", model: "claude-haiku-4-5" } as never, {}, undefined, engineConfig, logger, undefined,
      { sessionKey: "b31e1fe5-session", sessions },
    );
    const system = msg("system", "You are terse.");
    const first = msg("user", `Reference text (ignore it): ${filler(1800)}\nReply with exactly the single word: ok`);

    const r1 = await provider().chat({ messages: [system, first] });
    const u1 = r1.rawUsage as IUsage;
    expect(context(u1)).toBeGreaterThan(4_000); // the first task really is a multi-thousand-token prefix

    const second = msg("user", "What single word did you reply earlier?");
    const r2 = await provider().chat({ messages: [system, first, msg("assistant", r1.message.content ?? ""), second] });
    const u2 = r2.rawUsage as IUsage;

    const ratio = (u2.cache_read_input_tokens ?? 0) / context(u2);
    console.info(`b31e1fe5 measured: task1 ctx=${context(u1)} w1h=${u1.cache_creation?.ephemeral_1h_input_tokens}; task2 ctx=${context(u2)} cache_read=${u2.cache_read_input_tokens} w1h=${u2.cache_creation?.ephemeral_1h_input_tokens} ratio=${ratio.toFixed(3)}`);
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    // The old cold rewrite wrote ~the whole first-task prefix again at the 1h rate; now only the new tail.
    expect(u2.cache_creation?.ephemeral_1h_input_tokens ?? 0).toBeLessThan((u1.cache_creation?.ephemeral_1h_input_tokens ?? 0) * 0.5);
  }, 180_000);
});
