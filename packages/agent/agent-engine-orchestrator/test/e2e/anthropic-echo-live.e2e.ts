/**
 * anthropic-echo-live.e2e.ts -- R9-hist S7 (spec-v2 AC13, items (a)-(f)): does the LIVE Anthropic Messages API
 * accept the assistant history this package replays (thinking signatures, executed server tool pairs, tier S
 * stripped after the TTL, the deferred server_tool_use tail)? The offline contract fake encodes only the documented
 * rules; this file is the one check of what the real API enforces.
 *
 * guards: the live Anthropic Messages API rejects (HTTP 400) the assistant history this package replays (thinking signatures, executed server tool pairs, post-TTL stripped history, the deferred server_tool_use tail) although the offline contract fake accepts it.
 * tier: X (a real paid model, gate ADHD_AGENT_LIVE_ECHO=1, approver nix, repo owner; the always-running half uses a fake fetch only)
 * gap: This cannot be observed at tier P because whether the API accepts a replayed history is decided only by the live Anthropic service, and the offline contract fake encodes the documented rules only.
 * cites: R9-hist S7 / spec-v2 AC13 items (a)-(f) (cited in the header).
 *
 * ── ENV-GATED (paid third-party model) -- OFF BY DEFAULT AND OFF IN CI ─────────────────────────────────────────
 * Gate:      ADHD_AGENT_LIVE_ECHO=1   (exactly "1"; an API key alone never turns it on)
 * Owner / approver: nix (repo owner).
 * Qualifying reason (repo AGENTS.md section 7, the ONLY one allowed): the live leg calls a REAL paid model
 *            (Anthropic claude-haiku-5-5, effort high, the model and effort the R8/R9 parity rounds used).
 * Record:    the same gate record is in this package's README.md ("Live tests") and AGENTS.md ("Live tests").
 * Cost bound: at most 6 real requests (hard counter, the 7th is refused before it is sent), each with
 *            max_tokens 4096 and a one-line prompt, no retries (retries: 0). Typical run: 4 requests
 *            (1 fetch turn, 1 replay, 1 post-TTL replay, 1 deferred-tail probe), under 25k output tokens in total.
 * Default CI: never runs the live leg. With the gate unset every live test is reported SKIPPED with a reason that
 *            names the gate and the owner, and NOTHING in this file touches the network: the always-running half
 *            uses a fake `fetch` only. Enabling the gate without ANTHROPIC_API_KEY turns the suite RED (no silent
 *            skip once enabled).
 *
 * What the live leg does (items map to spec-v2 AC13):
 *  - REAL `AnthropicProvider` (real `@anthropic-ai/sdk` stream parser, real `output_config.effort`), REAL
 *    `SessionStore` on a migrated on-disk SQLite file under `tmp/agent-engine-orchestrator/` (shipped migrations,
 *    incl. 0017), REAL `partitionEcho`, and a REOPENED connection for every read. The engine loop around the
 *    provider is proven offline by `orchestrator-echo.test.ts` / the S6 session test; here the provider and the
 *    store meet the live API directly, so a rejection is attributable to the replayed history alone.
 *  - Turn 1 asks for one `web_fetch` of https://example.com; its echo is persisted and reloaded.
 *  - (a) replaying the real thinking turn: every replayed thinking signature is byte-identical to the captured one
 *        and the API returns no 400 (`echoDegraded` absent AND no 4xx on the wire). A turn that carries no thinking
 *        block fails ONLY this item, as "(a) NOT EXERCISED"; it never blocks (b)(c)(e)(f);
 *  - (b) replaying the real `server_tool_use` + `web_fetch_tool_result` pair, including the `citations` /
 *        `caller` / `citations: null` shapes exactly as the API emitted them, returns no 400;
 *  - (c) an empty `text` block injected into the replayed turn is dropped before the request and the request is accepted;
 *  - (d) a real `pause_turn` continuation completes IF the model produces one (`reportedModelCalls > 1`); when it
 *        does not, the report says "not exercised" -- it is never faked;
 *  - (e) the post-TTL shape (tier S stripped by the store read, tier T kept) returns no 400;
 *  - (f) the deferred-tail shape (a dangling `server_tool_use` as the final assistant message) is exercised LAST,
 *        through a raw SDK client (the provider's sanitiser would drop the tail), and reported separately as
 *        INFORMATIONAL: whether the API accepts it gates S3b; the test does not fail on either answer.
 *
 * Turn 1 prerequisites: the executed web_fetch pair (server_tool_use + a non-errored web_fetch_tool_result) is the
 *            only hard prerequisite of (b)(c)(e)(f). Before any prerequisite is checked, turn 1 writes ONE diagnostics
 *            line to the report: HTTP statuses, normalised stop_reason, ordered block types and per-type counts,
 *            output_tokens, elapsed ms, whether the sent request carried a `thinking` field, its
 *            `output_config.effort`, and the pair status. The provider has no public switch that sends `thinking`
 *            (it sends `output_config.effort` only), so whether thinking blocks appear is the model's choice at
 *            this effort; the diagnostics line records that fact rather than guessing.
 *
 * Redaction: assertions go through `check(boolean, safeMessage)` and compare hashes/counts only, so a failure never
 * prints a signature, page text, a request body or an API key. The summary lists block TYPES, counts, statuses and
 * booleans only.
 *
 * Run (owner only; NOT run by the agent that wrote this file; from the repo root):
 *   ADHD_AGENT_LIVE_ECHO=1 ANTHROPIC_API_KEY=<key> npx vitest run \
 *     --config packages/agent/agent-engine-orchestrator/vite.config.ts anthropic-echo-live
 * Do NOT gate through `nx run agent-engine-orchestrator:test`: nx's cache key is blind to this env var and can
 * replay a cached SKIPPED result.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 */
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, IProviderEcho } from "@adhd/agent-base-types";

import type { EngineConfig, EngineLogger } from "../../src/interfaces.js";
import { AnthropicProvider, redactApiMessage } from "../../src/providers/anthropic.js";
import { partitionEcho, type EchoCaps } from "../../src/providers/anthropic-echo.js";
import type { ProviderChatResponse } from "../../src/providers/types.js";
import type { Message } from "../../src/validation/index.js";
import { makeContractFake, type FakeStep, type IFakeReply } from "../fixtures/anthropic-contract-fake.js";
import { REAL_MIGRATIONS_FOLDER } from "../fixtures/real-schema-db.js";

// ── Gate ────────────────────────────────────────────────────────────────────────────────────────────────────────
const GATE = "ADHD_AGENT_LIVE_ECHO";
const OWNER = "nix (repo owner)";
const LIVE = process.env[GATE] === "1";
const SKIP_REASON = `SKIPPED: paid third-party model, gate ${GATE}=1, owner ${OWNER}`;
const liveDescribe = LIVE ? describe : describe.skip;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(HERE, "../../../../..");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp", "agent-engine-orchestrator");

// ── Budget and request shape ────────────────────────────────────────────────────────────────────────────────────
/** The claude-CLI alias `haiku` resolved to this concrete id in the parity rounds; the Messages API needs the id. */
const MODEL = "claude-haiku-5-5";
const EFFORT = "high";
const MAX_TOKENS = 4096;
/** Hard cap on real requests per run: the request after this many is refused BEFORE it is sent. */
export const MAX_REQUESTS = 6;
const TTL_MS = 10 * 60_000;
const CAPS: EchoCaps = { maxMessageBytes: 131_072, maxSessionBytes: 4_194_304, serverResultTtlMs: TTL_MS };
const WEB_FETCH = { type: "web_fetch_20250910", name: "web_fetch" } as const;

/**
 * Asks for one fetch AND a small piece of reasoning over the fetched page (compare two counts), so a reasoning model
 * has a reason to think after the tool result as well as before it. The answer is one sentence, well inside max_tokens.
 */
const PROMPT_FETCH =
  "Use the web_fetch tool exactly once on https://example.com. Then reason it through briefly and answer in one sentence: " +
  "does the page's main heading have more words, fewer words, or the same number of words as the page's first sentence of body text?";
const PROMPT_FOLLOW_UP = "In five words or fewer, what was the main heading of that page?";
const PROMPT_AFTER_TTL = "Without using any tool, reply with the single word: ready.";

// ── Redaction-safe assertion + hashing helpers ──────────────────────────────────────────────────────────────────
/** Throws with `message` (which must be free of block content) unless `cond` holds. */
export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`anthropic-echo-live: ${message}`);
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

type Block = Record<string, unknown>;

/** The block as the API would see it, minus `cache_control` (the provider's cache breakpoints, not echo content). */
function withoutCacheControl(block: Block): Block {
  const copy: Block = { ...block };
  delete copy["cache_control"];
  return copy;
}

/** Safe-to-print facts about one content block: its type, a content hash and (for signed blocks) a signature hash. */
export interface IBlockFact {
  type: string;
  hash: string;
  sigHash?: string;
  emptyText: boolean;
}

export function blockFact(block: Block): IBlockFact {
  const type = typeof block["type"] === "string" ? block["type"] : "unknown";
  // thinking carries `signature`; redacted_thinking carries its opaque payload in `data`.
  let signed: string | undefined;
  if (typeof block["signature"] === "string") signed = block["signature"];
  else if (type === "redacted_thinking" && typeof block["data"] === "string") signed = block["data"];
  return {
    type,
    hash: sha(JSON.stringify(withoutCacheControl(block))),
    ...(signed !== undefined ? { sigHash: sha(signed) } : {}),
    emptyText: type === "text" && block["text"] === "",
  };
}

const isServerBlock = (type: string): boolean => type === "server_tool_use" || type === "mcp_tool_use" || (type !== "tool_result" && type.endsWith("_tool_result"));

/** What one outbound request body contained, reduced to safe facts (one entry per assistant message, in order). */
export interface IBodyFacts {
  model: string;
  effort: string | undefined;
  /** True when the sent request carried a top-level `thinking` field (the field itself is never kept). */
  thinkingOnWire: boolean;
  /** The `thinking.type` value (e.g. "adaptive") when it is a short plain token, else undefined. */
  thinkingType: string | undefined;
  assistant: IBlockFact[][];
}

/** A short plain token (type names, enum values) passes through; anything else becomes "?" so content cannot ride along. */
export function safeToken(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(value) ? value : "?";
}

export function inspectBody(body: string): IBodyFacts {
  const parsed = JSON.parse(body) as {
    model?: unknown;
    output_config?: { effort?: unknown };
    thinking?: { type?: unknown } | null;
    messages?: Array<{ role?: unknown; content?: unknown }>;
  };
  const assistant = (parsed.messages ?? [])
    .filter((m) => m.role === "assistant")
    .map((m): IBlockFact[] =>
      typeof m.content === "string"
        ? [blockFact({ type: "text", text: m.content })]
        : (Array.isArray(m.content) ? (m.content as Block[]) : []).map(blockFact)
    );
  return {
    model: typeof parsed.model === "string" ? parsed.model : "",
    effort: typeof parsed.output_config?.effort === "string" ? safeToken(parsed.output_config.effort) : undefined,
    thinkingOnWire: parsed.thinking !== undefined && parsed.thinking !== null,
    thinkingType: typeof parsed.thinking?.type === "string" ? safeToken(parsed.thinking.type) : undefined,
    assistant,
  };
}

/** One real (or faked, offline) HTTP request as the counting fetch saw it. */
export interface IRequestFact extends IBodyFacts {
  index: number;
  status: number;
}

/**
 * `fetch` wrapper installed on the provider's wire seam: counts requests, refuses the one past `maxRequests`
 * BEFORE it reaches `realFetch`, and records safe facts about each body and the response status. It never reads the
 * response body and never logs.
 */
export function makeCountingFetch(realFetch: typeof fetch, facts: IRequestFact[], maxRequests: number): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    check(facts.length < maxRequests, `request cap ${maxRequests} reached; refusing request ${facts.length + 1} before it is sent`);
    const body = init?.body;
    check(typeof body === "string", "outbound request body is not a string, so it cannot be inspected");
    const fact: IRequestFact = { index: facts.length + 1, status: 0, ...inspectBody(body) };
    facts.push(fact);
    const response = await realFetch(input, init);
    fact.status = response.status;
    return response;
  }) as typeof fetch;
}

// ── The rig: provider + store + counting fetch ──────────────────────────────────────────────────────────────────
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as EngineLogger;

function agentDefinition(): AgentDefinition {
  const now = new Date().toISOString();
  return {
    name: "echo-live",
    version: 1,
    provider: { type: "anthropic", model: MODEL } as AgentDefinition["provider"],
    systemPrompt: "You are a terse test agent.",
    mcpServers: {},
    permissions: {},
    createdAt: now,
    updatedAt: now,
  };
}

const message = (sessionId: string, role: Message["role"], content: string): Message => ({
  id: randomUUID(),
  sessionId,
  role,
  content,
  createdAt: new Date().toISOString(),
});

const typesOf = (blocks: readonly Block[]): string[] => blocks.map((b) => String(b["type"]));
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** True when `key` appears anywhere in the JSON value with a `null` value (e.g. `citations: null`). */
function hasNullKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasNullKey(v, key));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([k, v]) => (k === key && v === null) || hasNullKey(v, key));
}
function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, key));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([k, v]) => k === key || hasKey(v, key));
}

/** Whether the executed web_fetch pair (the hard prerequisite of (b)(c)(e)(f)) is present in a captured turn. */
export interface IPairStatus {
  state: "ok" | "no_server_tool_use" | "no_result" | "errored";
  /** The API's short error code when the fetch errored and the code is a plain token. */
  errorCode?: string;
}

/** Classifies the captured blocks: a `server_tool_use` named web_fetch whose `web_fetch_tool_result` exists and is not an error. */
export function fetchPairStatus(blocks: readonly Block[]): IPairStatus {
  const uses = blocks.filter((b) => b["type"] === "server_tool_use" && b["name"] === "web_fetch");
  if (uses.length === 0) return { state: "no_server_tool_use" };
  let failure: IPairStatus = { state: "no_result" };
  for (const use of uses) {
    const result = blocks.find((b) => b["type"] === "web_fetch_tool_result" && b["tool_use_id"] === use["id"]);
    if (result === undefined) continue;
    const content = result["content"];
    const contentType = typeof content === "object" && content !== null ? (content as Block)["type"] : undefined;
    if (typeof contentType === "string" && contentType.includes("error")) {
      const code = (content as Block)["error_code"];
      failure = { state: "errored", ...(typeof code === "string" ? { errorCode: safeToken(code) } : {}) };
      continue;
    }
    return { state: "ok" };
  }
  return failure;
}

/** Everything the turn 1 diagnostics line reports, reduced to types, counts, numbers and booleans. */
export interface ITurnDiagnostics {
  statuses: readonly number[];
  stopReason: string | undefined;
  blockTypes: readonly string[];
  outputTokens: number | undefined;
  modelCalls: number;
  elapsedMs: number;
  wire: { thinkingOnWire: boolean; thinkingType: string | undefined; effort: string | undefined } | undefined;
  pair: IPairStatus;
}

const num = (n: number | undefined): string => (n !== undefined && Number.isFinite(n) ? String(Math.round(n)) : "unknown");

/**
 * The ONE diagnostics line for turn 1. Every string that reaches it passes through {@link safeToken} and every other
 * value is a number or boolean, so no signature, page text, body or key can be printed through it.
 */
export function formatTurnDiagnostics(d: ITurnDiagnostics): string {
  const types = d.blockTypes.map(safeToken);
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const countText = [...counts].map(([t, n]) => `${t}=${n}`).join(" ");
  const wire =
    d.wire === undefined
      ? "no request reached the wire"
      : `request thinking field ${d.wire.thinkingOnWire}${d.wire.thinkingType !== undefined ? ` (type ${safeToken(d.wire.thinkingType)})` : ""}, request output_config.effort ${d.wire.effort === undefined ? "absent" : safeToken(d.wire.effort)}`;
  const pair = d.pair.state === "errored" && d.pair.errorCode !== undefined ? `errored (${safeToken(d.pair.errorCode)})` : d.pair.state;
  return (
    `turn 1 diagnostics: http [${d.statuses.join(",")}]; stop_reason ${d.stopReason === undefined ? "unknown" : safeToken(d.stopReason)}; ` +
    `blocks [${types.join(", ")}]; counts {${countText}}; output_tokens ${num(d.outputTokens)}; model_calls ${d.modelCalls}; ` +
    `elapsed ${num(d.elapsedMs)} ms; ${wire}; web_fetch pair ${pair}`
  );
}

interface ITurnOne {
  user: Message;
  assistant: Message;
  response: ProviderChatResponse;
  captured: Block[];
  /** True when the captured turn carries a thinking / redacted_thinking block. */
  hasThinking: boolean;
}

export class EchoLiveRig {
  readonly facts: IRequestFact[] = [];
  readonly report: string[] = [];
  readonly dir: string;
  readonly file: string;
  readonly sessionId: string;
  private readonly provider: AnthropicProvider;
  private readonly countingFetch: typeof fetch;
  private readonly secret: string;
  private readonly conns: Database.Database[] = [];
  private turnOne: ITurnOne | undefined;
  private reportedModelCalls = 0;
  /** Set by {@link stepReplay}: the thinking signature hashes the capture carried vs the ones the replay sent. */
  private replaySigs: { want: string[]; wire: string[] } | undefined;

  constructor(opts: { secret: string; realFetch: typeof fetch; maxRequests?: number }) {
    this.secret = opts.secret;
    this.dir = join(SCRATCH_ROOT, `anthropic-echo-live-${process.pid}-${randomUUID().slice(0, 8)}`);
    mkdirSync(this.dir, { recursive: true });
    this.file = join(this.dir, "live.sqlite");
    const first = this.open();
    migrate(drizzle(first), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
    this.sessionId = new SessionStore(drizzle(first, { schema }) as never).create({
      agentName: "echo-live",
      agentDefinition: agentDefinition(),
    }).id;
    this.countingFetch = makeCountingFetch(opts.realFetch, this.facts, opts.maxRequests ?? MAX_REQUESTS);
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: MAX_TOKENS },
      wire: { fetch: this.countingFetch },
      getProviderConfig: () => ({ secret: opts.secret, model: MODEL }),
    } as unknown as EngineConfig;
    this.provider = new AnthropicProvider(
      { type: "anthropic", model: MODEL, effort: EFFORT, maxTokens: MAX_TOKENS, retryConfig: { retries: 0, minTimeout: 1, maxTimeout: 1, factor: 1 } } as never,
      config,
      silentLogger
    );
  }

  private open(): Database.Database {
    const conn = new Database(this.file);
    conn.pragma("foreign_keys = OFF");
    this.conns.push(conn);
    return conn;
  }

  /** A store on a FRESH connection: every read below proves persistence by reopening, never by in-memory reuse. */
  reopenedStore(): SessionStore {
    return new SessionStore(drizzle(this.open(), { schema }) as never);
  }

  /** Releases every connection and removes the scratch directory. Safe to call twice. */
  dispose(): void {
    for (const conn of this.conns.splice(0)) conn.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private note(line: string): void {
    this.report.push(line);
  }

  private newFacts<T>(before: number, run: () => Promise<T>): Promise<{ result: T; facts: IRequestFact[] }> {
    return run().then((result) => ({ result, facts: this.facts.slice(before) }));
  }

  private recordCalls(res: ProviderChatResponse): void {
    this.reportedModelCalls = Math.max(this.reportedModelCalls, res.reportedModelCalls ?? 1);
  }

  private requireTurnOne(): ITurnOne {
    check(this.turnOne !== undefined, "blocked by turn 1 (it did not complete, so no request was made for this item)");
    return this.turnOne;
  }

  /**
   * Turn 1: one real web_fetch turn; persists user + assistant + echo through the real store, then reloads.
   * The diagnostics line is written BEFORE any prerequisite is checked, so a failing turn still reports what it was.
   * Hard prerequisites: HTTP success, not max_tokens, the executed web_fetch pair. Thinking is NOT one (see (a)).
   */
  async stepFetchTurn(): Promise<void> {
    const user = message(this.sessionId, "user", PROMPT_FETCH);
    const before = this.facts.length;
    const started = Date.now();
    let res: ProviderChatResponse;
    try {
      res = await this.provider.chat({ messages: [user], serverSideTools: [WEB_FETCH] });
    } catch (err) {
      const sent = this.facts.slice(before);
      const status = sent[0]?.status ?? 0;
      this.note(
        formatTurnDiagnostics({
          statuses: sent.map((f) => f.status),
          stopReason: undefined,
          blockTypes: [],
          outputTokens: undefined,
          modelCalls: 0,
          elapsedMs: Date.now() - started,
          wire: sent[0] === undefined ? undefined : { thinkingOnWire: sent[0].thinkingOnWire, thinkingType: sent[0].thinkingType, effort: sent[0].effort },
          pair: { state: "no_server_tool_use" },
        })
      );
      const text = redactApiMessage((err as { message?: string }).message ?? "");
      check(false, `turn 1 failed before a response was produced (${safeToken((err as { name?: string }).name ?? "Error")}, HTTP ${status}): ${text}`);
    }
    const elapsedMs = Date.now() - started;
    const facts = this.facts.slice(before);
    this.recordCalls(res);
    const echoBlocks = res.echo === undefined ? undefined : (res.echo.blocks.map((b) => ({ ...b })) as Block[]);
    // With no replay-relevant block there is no echo; the visible shape is then text and/or client tool_use only.
    const blockTypes = echoBlocks !== undefined ? typesOf(echoBlocks) : [...(res.message.content ? ["text"] : []), ...(res.message.toolCalls ?? []).map(() => "tool_use")];
    const pair = fetchPairStatus(echoBlocks ?? []);
    this.note(
      formatTurnDiagnostics({
        statuses: facts.map((f) => f.status),
        stopReason: res.usage?.stopReason,
        blockTypes,
        outputTokens: res.usage?.outputTokens,
        modelCalls: res.reportedModelCalls ?? 1,
        elapsedMs,
        wire: facts[0] === undefined ? undefined : { thinkingOnWire: facts[0].thinkingOnWire, thinkingType: facts[0].thinkingType, effort: facts[0].effort },
        pair,
      })
    );

    check(facts.every((f) => f.status > 0 && f.status < 400), `turn 1 was rejected by the API (statuses ${facts.map((f) => f.status).join(",")})`);
    check(res.usage?.stopReason !== "length", "turn 1 stopped on max_tokens: inconclusive, re-run");
    check(echoBlocks !== undefined, "turn 1 produced no executed web_fetch pair (no server_tool_use / web_fetch_tool_result in the response): (b)(c)(e)(f) are blocked by turn 1, (a) NOT EXERCISED");
    check(pair.state === "ok", `turn 1 produced no executed web_fetch pair (pair status ${pair.state}${pair.errorCode !== undefined ? ` ${pair.errorCode}` : ""}): (b)(c)(e)(f) are blocked by turn 1`);
    const captured = echoBlocks;
    const types = typesOf(captured);
    const hasThinking = types.includes("thinking") || types.includes("redacted_thinking");

    const assistant: Message = { ...res.message, sessionId: this.sessionId };
    const store = this.reopenedStore();
    store.appendMessage(this.sessionId, user);
    store.appendMessage(this.sessionId, assistant);
    const echo = res.echo;
    check(echo !== undefined, "turn 1 echo vanished after the pair check");
    const part = partitionEcho(echo, CAPS, store.getEchoSessionServerBytes(this.sessionId), true);
    check(part.persist !== undefined, `partitionEcho refused to persist the real echo (${part.reason ?? "no reason"})`);
    store.appendMessageEcho(assistant.id, this.sessionId, part.persist.echo, part.persist.bytes, part.persist.serverBytes);

    // Round trip: what the next reader gets is the captured echo, block for block.
    const reloaded = this.reopenedStore().getMessageEchoes(this.sessionId, [assistant.id], 60_000, TTL_MS).get(assistant.id);
    check(reloaded !== undefined, "the persisted echo could not be reloaded from a reopened store");
    check(
      sameList(reloaded.blocks.map((b) => blockFact(b as Block).hash), captured.map((b) => blockFact(b).hash)),
      "the persisted echo is not byte-identical to the captured echo after a store round trip"
    );
    this.turnOne = { user, assistant, response: res, captured, hasThinking };
    this.note(`turn 1: statuses ${facts.map((f) => f.status).join(",")}; captured block types [${types.join(", ")}]; persisted ${part.persist.bytes} bytes (${part.persist.serverBytes} tier S)`);
    this.note(
      `shapes (b): web_fetch_tool_result has citations key ${hasKey(captured, "citations")}, citations:null ${hasNullKey(captured, "citations")}, ` +
        `server_tool_use has caller key ${hasKey(captured.filter((b) => b["type"] === "server_tool_use"), "caller")}`
    );
  }

  /** (a)(b)(c): replay the reloaded echo (plus an injected empty text block) and require an accepted, byte-identical replay. */
  async stepReplay(): Promise<void> {
    const t1 = this.requireTurnOne();
    const reloaded = this.reopenedStore().getMessageEchoes(this.sessionId, [t1.assistant.id], 60_000, TTL_MS).get(t1.assistant.id);
    check(reloaded !== undefined, "replay: the echo is missing from the reopened store");
    const withEmpty: IProviderEcho = { ...reloaded, blocks: [...reloaded.blocks, { type: "text", text: "" }] };
    const user2 = message(this.sessionId, "user", PROMPT_FOLLOW_UP);
    const { result: res, facts } = await this.newFacts(this.facts.length, () =>
      this.provider.chat({
        messages: [t1.user, t1.assistant, user2],
        serverSideTools: [WEB_FETCH],
        echoes: new Map([[t1.assistant.id, withEmpty]]),
      })
    );
    this.recordCalls(res);
    check(facts.length >= 1 && facts.every((f) => f.status > 0 && f.status < 400), `replay was rejected by the API (statuses ${facts.map((f) => f.status).join(",")})`);
    check(res.echoDegraded === undefined, "replay: the provider had to degrade to legacy history (the API rejected the echoed blocks)");
    check(res.echoReplay?.messages === 1, "replay: the echo was not replayed (echoReplay.messages !== 1)");

    const wire = facts[0]?.assistant[0];
    check(wire !== undefined, "replay: no assistant message on the wire");
    const want = t1.captured.filter((b) => !(b["type"] === "text" && b["text"] === "")).map(blockFact);
    check(sameList(wire.map((b) => b.hash), want.map((b) => b.hash)), "replay: the replayed assistant blocks are not byte-identical to the captured blocks (a)(b)");
    check(!wire.some((b) => b.emptyText), "replay: an empty text block reached the wire (c)");
    const wantSigs = want.filter((b) => b.sigHash !== undefined).map((b) => b.sigHash as string);
    const wireSigs = wire.filter((b) => b.sigHash !== undefined).map((b) => b.sigHash as string);
    this.replaySigs = { want: wantSigs, wire: wireSigs };
    this.note(
      `(b) PASS: server pair replayed byte-identical, no 400; (c) PASS: empty text block dropped before send, request accepted; ` +
        `wire types [${wire.map((b) => b.type).join(", ")}]; statuses ${facts.map((f) => f.status).join(",")}`
    );
  }

  /**
   * (a): the replayed thinking signatures are byte-identical to the captured ones. Makes no request. A turn 1 without
   * a thinking block fails ONLY here, worded "NOT EXERCISED", and leaves (b)(c)(e)(f) untouched.
   */
  stepThinkingReplay(): void {
    const t1 = this.requireTurnOne();
    if (!t1.hasThinking) {
      this.note("(a) NOT EXERCISED: turn 1 produced no thinking block, so there was no signature to replay; (b)(c)(e)(f) ran without it");
      check(false, "(a) NOT EXERCISED: turn 1 produced no thinking block (no signature to replay); this fails only item (a)");
    }
    check(this.replaySigs !== undefined, "blocked by the replay step (it did not complete, so no replayed signatures exist to compare)");
    const { want, wire } = this.replaySigs;
    check(want.length > 0 && sameList(wire, want), "replay: thinking signatures on the wire differ from the captured ones (a)");
    this.note(`(a) PASS: ${want.length} thinking signature(s) replayed byte-identical, no 400`);
  }

  /** (e): tier S stripped by the store read (session idle past the TTL), tier T kept. */
  async stepPostTtlReplay(): Promise<void> {
    const t1 = this.requireTurnOne();
    const stripped = this.reopenedStore().getMessageEchoes(this.sessionId, [t1.assistant.id], TTL_MS * 2, TTL_MS).get(t1.assistant.id);
    check(stripped !== undefined, "(e): nothing is left of the echo after the tier S strip, so the post-TTL shape cannot be exercised");
    const strippedTypes = typesOf(stripped.blocks as Block[]);
    check(!strippedTypes.some(isServerBlock), "(e): the store read left tier S blocks in an expired session");
    // Tier T is "thinking if the turn had any"; a turn without thinking keeps only its text, and (e) still runs on that.
    check(!t1.hasThinking || strippedTypes.some((t) => t === "thinking" || t === "redacted_thinking"), "(e): the stripped echo kept no thinking block");
    const user3 = message(this.sessionId, "user", PROMPT_AFTER_TTL);
    const { result: res, facts } = await this.newFacts(this.facts.length, () =>
      this.provider.chat({
        messages: [t1.user, t1.assistant, user3],
        serverSideTools: [WEB_FETCH],
        echoes: new Map([[t1.assistant.id, stripped]]),
      })
    );
    this.recordCalls(res);
    check(facts.length >= 1 && facts.every((f) => f.status > 0 && f.status < 400), `(e): post-TTL replay was rejected by the API (statuses ${facts.map((f) => f.status).join(",")})`);
    check(res.echoDegraded === undefined, "(e): the provider had to degrade to legacy history");
    check(res.echoReplay?.messages === 1, "(e): the stripped echo was not replayed");
    const wire = facts[0]?.assistant[0];
    check(wire !== undefined, "(e): no assistant message on the wire");
    check(!wire.some((b) => isServerBlock(b.type)), "(e): a tier S block reached the wire after the TTL strip");
    check(
      sameList(wire.map((b) => b.hash), (stripped.blocks as Block[]).filter((b) => !(b["type"] === "text" && b["text"] === "")).map((b) => blockFact(b).hash)),
      "(e): the replayed tier T blocks are not byte-identical to the persisted ones"
    );
    this.note(`(e) PASS: post-TTL shape [${wire.map((b) => b.type).join(", ")}] accepted, no 400; statuses ${facts.map((f) => f.status).join(",")}`);
  }

  /** (d): reported from what the real calls above produced; never forced and never faked. */
  stepPauseReport(): void {
    this.note(
      this.reportedModelCalls > 1
        ? `(d) EXERCISED: a real turn needed ${this.reportedModelCalls} model calls (pause_turn continuation) and completed`
        : "(d) NOT EXERCISED: the model produced no pause_turn in this run (reportedModelCalls <= 1)"
    );
  }

  /**
   * (f) INFORMATIONAL, run LAST: a dangling `server_tool_use` as the final assistant message (its result absent).
   * Sent through a raw SDK client because `sanitizeServerToolPairs` drops such a tail. Records acceptance; never fails
   * the suite on either answer (only on a transport failure that says nothing about the API).
   */
  async stepDeferredTail(): Promise<void> {
    const t1 = this.requireTurnOne();
    const firstUse = t1.captured.findIndex((b) => b["type"] === "server_tool_use");
    check(firstUse >= 0, "(f): the captured turn has no server_tool_use to leave dangling");
    const tail = t1.captured.slice(0, firstUse + 1);
    const client = new Anthropic({ apiKey: this.secret, maxRetries: 0, timeout: 120_000, fetch: this.countingFetch });
    const before = this.facts.length;
    let outcome: string;
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        output_config: { effort: EFFORT },
        tools: [WEB_FETCH],
        messages: [
          { role: "user", content: t1.user.content ?? "" },
          { role: "assistant", content: tail },
        ],
      } as unknown as Anthropic.MessageCreateParamsNonStreaming);
      outcome = `ACCEPTED (stop_reason ${String(response.stop_reason)}, response block types [${response.content.map((b) => b.type).join(", ")}])`;
    } catch (err) {
      const status = this.facts[before]?.status ?? 0;
      check(status >= 400, "(f): the deferred-tail probe failed before the API answered (transport error): inconclusive, re-run");
      const text = redactApiMessage((err as { message?: string }).message ?? "");
      outcome = `REJECTED with HTTP ${status}: ${text}`;
    }
    this.note(`(f) INFORMATIONAL (gates S3b): deferred-tail shape [${typesOf(tail).join(", ")}] was ${outcome}`);
  }

  summary(): string {
    return [`anthropic-echo-live summary (${this.facts.length} request(s), cap ${MAX_REQUESTS}):`, ...this.report.map((l) => `  ${l}`)].join("\n");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// OFFLINE: always runs, never touches the network (a fake `fetch` only). Gives the live leg's helpers teeth.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S7 -- offline controls for the gated live test (no network)", () => {
  const okFetch = (calls: { n: number }): typeof fetch =>
    (async () => {
      calls.n += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

  it("S7 gate documentation: header, README.md and AGENTS.md all name the gate and the owner", () => {
    const header = readFileSync(join(HERE, "anthropic-echo-live.e2e.ts"), "utf8").split("\n").slice(0, 40).join("\n");
    for (const [name, text] of [
      ["test header", header],
      ["README.md", readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8")],
      ["AGENTS.md", readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8")],
    ] as const) {
      expect(text.includes(GATE), `${name} must name the gate ${GATE}`).toBe(true);
      expect(text.includes(OWNER), `${name} must name the owner "${OWNER}"`).toBe(true);
    }
  });

  it("S7 request cap: the request past the cap is refused before it reaches fetch (negative control: cap raised => it would be sent)", async () => {
    const calls = { n: 0 };
    const facts: IRequestFact[] = [];
    const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
    const capped = makeCountingFetch(okFetch(calls), facts, 2);
    await capped("https://example.test/v1/messages", { method: "POST", body });
    await capped("https://example.test/v1/messages", { method: "POST", body });
    await expect(capped("https://example.test/v1/messages", { method: "POST", body })).rejects.toThrow(/request cap 2 reached/);
    expect(calls.n).toBe(2);
    const open = makeCountingFetch(okFetch(calls), [], 3);
    await open("https://example.test/v1/messages", { method: "POST", body });
    expect(calls.n).toBe(3);
  });

  it("S7 counting fetch refuses a body it cannot inspect (a streamed body would hide content from the counter)", async () => {
    const calls = { n: 0 };
    const guarded = makeCountingFetch(okFetch(calls), [], 6);
    await expect(guarded("https://example.test/v1/messages", { method: "POST", body: new Uint8Array([1]) })).rejects.toThrow(/cannot be inspected/);
    expect(calls.n).toBe(0);
  });

  it("S7 body facts: signature and block hashes ignore cache_control, empty text is flagged, no content leaks into the facts", () => {
    const sig = "SIGSENTINEL" + "Q".repeat(40);
    const page = "PAGE-BODY-SENTINEL";
    const body = JSON.stringify({
      model: MODEL,
      output_config: { effort: EFFORT },
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: sig },
            { type: "text", text: "" },
            { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1", content: { text: page }, cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
    const facts = inspectBody(body);
    expect(facts.effort).toBe(EFFORT);
    const blocks = facts.assistant[0] as IBlockFact[];
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "web_fetch_tool_result"]);
    expect(blocks[0]?.sigHash).toBe(sha(sig));
    expect(blocks[1]?.emptyText).toBe(true);
    expect(blocks[2]?.hash).toBe(blockFact({ type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1", content: { text: page } }).hash);
    expect(JSON.stringify(facts).includes(sig)).toBe(false);
    expect(JSON.stringify(facts).includes(page)).toBe(false);
  });

  it("S7 check(): a failure message carries only the supplied safe text", () => {
    expect(() => check(false, "safe words")).toThrow("anthropic-echo-live: safe words");
    expect(() => check(true, "never thrown")).not.toThrow();
  });

  it("S7 rig mechanics: items (a)(b)(c)(e)(d) run end to end against the offline contract fake (real provider, real store, reopened connections)", async () => {
    const sig = "SIGSENTINEL" + "Z".repeat(60);
    const step = (blocks: IFakeReply["blocks"]): FakeStep => ({ blocks });
    const fake = makeContractFake([
      step([
        { type: "thinking", thinking: "", signature: sig },
        { type: "server_tool_use", id: "srvtoolu_live_1", name: "web_fetch", input: { url: "https://example.com" } },
        { type: "text", text: "It is an example page." },
      ]),
      step([{ type: "text", text: "Example Domain" }]),
      step([{ type: "text", text: "ready" }]),
    ]);
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: fake.fetch });
    try {
      await rig.stepFetchTurn();
      await rig.stepReplay();
      rig.stepThinkingReplay();
      await rig.stepPostTtlReplay();
      rig.stepPauseReport();
      expect(fake.rejections()).toEqual([]);
      expect(fake.faults).toEqual([]);
      expect(rig.facts.map((f) => f.status)).toEqual([200, 200, 200]);
      // The summary is safe to print: no signature, no key.
      expect(rig.summary().includes(sig)).toBe(false);
      expect(rig.summary()).toMatch(/\(a\) PASS/);
      expect(rig.summary()).toMatch(/\(e\) PASS/);
      expect(rig.summary()).toMatch(/\(d\) NOT EXERCISED/);
    } finally {
      rig.dispose();
    }
  });

  it("S7 rig mechanics negative control: a rejected replay (API 400 naming the thinking signature) fails the replay step loudly", async () => {
    const fake = makeContractFake(
      [
        { blocks: [{ type: "thinking", thinking: "", signature: "SIGSENTINEL" + "Y".repeat(60) }, { type: "server_tool_use", id: "srvtoolu_live_2", name: "web_fetch", input: { url: "https://example.com" } }, { type: "text", text: "ok" }] },
        { error: { status: 400, type: "invalid_request_error", message: "messages.1.content.0: thinking block signature is invalid" } },
        { blocks: [{ type: "text", text: "legacy retry answer" }] },
      ],
      { allowThinkingOmission: true }
    );
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: fake.fetch });
    try {
      await rig.stepFetchTurn();
      await expect(rig.stepReplay()).rejects.toThrow(/replay was rejected by the API|degrade to legacy history/);
    } finally {
      rig.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// OFFLINE (S7b): turn 1 diagnostics and the split between the hard pair prerequisite and the soft thinking item.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S7b AC13 -- turn 1 diagnostics and prerequisites (offline contract fake, no network)", () => {
  const PAGE = "PAGE-BODY-SENTINEL";
  const fetchStep = (extra: IFakeReply["blocks"] = []): FakeStep => ({
    blocks: [
      ...extra,
      { type: "server_tool_use", id: "srvtoolu_s7b", name: "web_fetch", input: { url: "https://example.com" } },
      { type: "text", text: `The heading has two words. ${PAGE}` },
    ],
  });

  /** Streaming requests go to the contract fake; the non-streaming (f) probe gets a plain 200 so it can run offline. */
  const withProbeAnswer = (fake: ReturnType<typeof makeContractFake>): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const parsed = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (parsed.stream === true) return fake.fetch(input, init);
      return new Response(
        JSON.stringify({ id: "msg_probe", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

  it("R9-hist S7b AC13 diagnostics: turn 1 reports statuses, stop reason, block types, counts, tokens, elapsed, wire thinking/effort and pair status, and nothing else", async () => {
    const sig = "SIGSENTINEL" + "D".repeat(60);
    const fake = makeContractFake([fetchStep([{ type: "thinking", thinking: "", signature: sig }])]);
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: fake.fetch });
    try {
      await rig.stepFetchTurn();
      const line = rig.report.find((l) => l.startsWith("turn 1 diagnostics:")) ?? "";
      expect(line).toMatch(/http \[200\]/);
      expect(line).toMatch(/stop_reason \S+/);
      expect(line).toContain("blocks [thinking, server_tool_use, web_fetch_tool_result, text]");
      expect(line).toContain("thinking=1");
      expect(line).toContain("server_tool_use=1");
      expect(line).toMatch(/output_tokens (\d+|unknown)/);
      expect(line).toMatch(/elapsed \d+ ms/);
      expect(line).toContain("request thinking field false");
      expect(line).toContain(`request output_config.effort ${EFFORT}`);
      expect(line).toContain("web_fetch pair ok");
      // Negative control for the redaction promise: no signature, no page/answer text, no key anywhere in what is printed.
      for (const secret of [sig, PAGE, "sk-ant-api-test-secret", "example.com"]) expect(rig.summary().includes(secret)).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it("R9-hist S7b AC13 diagnostics negative control: hostile strings (a signature-like type, page text as a stop reason) cannot ride the diagnostics line", () => {
    const hostileType = "SIGSENTINEL" + "Q".repeat(60);
    const line = formatTurnDiagnostics({
      statuses: [200],
      stopReason: `${PAGE} with spaces`,
      blockTypes: ["text", hostileType, `${PAGE} text`],
      outputTokens: 12,
      modelCalls: 1,
      elapsedMs: 5,
      wire: { thinkingOnWire: true, thinkingType: "adaptive", effort: `${PAGE} effort` },
      pair: { state: "errored", errorCode: safeToken(`${PAGE} code`) },
    });
    expect(line.includes("SIGSENTINEL")).toBe(false);
    expect(line.includes(PAGE)).toBe(false);
    expect(line).toContain("blocks [text, ?, ?]");
    expect(line).toContain("request thinking field true (type adaptive)");
    expect(line).toContain("stop_reason ?");
  });

  it("R9-hist S7b AC13 request facts: a sent `thinking` field is reported as a boolean plus its plain type, an absent one as false", () => {
    const withThinking = inspectBody(JSON.stringify({ model: MODEL, thinking: { type: "adaptive" }, output_config: { effort: "high" }, messages: [] }));
    expect(withThinking.thinkingOnWire).toBe(true);
    expect(withThinking.thinkingType).toBe("adaptive");
    const without = inspectBody(JSON.stringify({ model: MODEL, messages: [] }));
    expect(without.thinkingOnWire).toBe(false);
    expect(without.thinkingType).toBeUndefined();
  });

  it("R9-hist S7b AC13 pair status: ok, no server_tool_use, no result and errored results are told apart", () => {
    const use = { type: "server_tool_use", id: "srvtoolu_1", name: "web_fetch", input: {} };
    expect(fetchPairStatus([{ type: "text", text: "x" }]).state).toBe("no_server_tool_use");
    expect(fetchPairStatus([use]).state).toBe("no_result");
    expect(fetchPairStatus([use, { type: "web_fetch_tool_result", tool_use_id: "other", content: { type: "web_fetch_result" } }]).state).toBe("no_result");
    expect(fetchPairStatus([use, { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_fetch_result" } }]).state).toBe("ok");
    expect(fetchPairStatus([use, { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_fetch_tool_result_error", error_code: "url_not_allowed" } }])).toEqual({
      state: "errored",
      errorCode: "url_not_allowed",
    });
  });

  it("R9-hist S7b AC13 no thinking: only (a) fails (NOT EXERCISED); the pair, (b)(c), (e) and (f) still run and pass", async () => {
    const fake = makeContractFake([fetchStep(), { blocks: [{ type: "text", text: "Example Domain" }] }, { blocks: [{ type: "text", text: "ready" }] }]);
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: withProbeAnswer(fake) });
    try {
      await rig.stepFetchTurn();
      await rig.stepReplay();
      expect(() => rig.stepThinkingReplay()).toThrow(/\(a\) NOT EXERCISED: turn 1 produced no thinking block/);
      await rig.stepPostTtlReplay();
      await rig.stepDeferredTail();
      rig.stepPauseReport();
      expect(fake.rejections()).toEqual([]);
      expect(fake.faults).toEqual([]);
      const summary = rig.summary();
      expect(summary).toMatch(/\(b\) PASS/);
      expect(summary).toMatch(/\(e\) PASS/);
      expect(summary).toMatch(/\(f\) INFORMATIONAL .*ACCEPTED/);
      expect(summary).toMatch(/\(a\) NOT EXERCISED/);
      expect(summary).not.toMatch(/\(a\) PASS/);
      expect(rig.facts.length).toBe(4);
    } finally {
      rig.dispose();
    }
  });

  it("R9-hist S7b AC13 thinking present: (a) passes after the replay, and fails loudly if the replay step never ran", async () => {
    const sig = "SIGSENTINEL" + "T".repeat(60);
    const fake = makeContractFake([fetchStep([{ type: "thinking", thinking: "", signature: sig }]), { blocks: [{ type: "text", text: "Example Domain" }] }]);
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: fake.fetch });
    try {
      await rig.stepFetchTurn();
      expect(() => rig.stepThinkingReplay()).toThrow(/blocked by the replay step/);
      await rig.stepReplay();
      rig.stepThinkingReplay();
      expect(rig.summary()).toMatch(/\(a\) PASS: 1 thinking signature/);
      expect(rig.summary().includes(sig)).toBe(false);
    } finally {
      rig.dispose();
    }
  });

  it("R9-hist S7b AC13 no pair: turn 1 fails with its diagnostics, every later item reports blocked by turn 1, and no further request is sent", async () => {
    const fake = makeContractFake([{ blocks: [{ type: "text", text: `I could not fetch it. ${PAGE}` }] }]);
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: withProbeAnswer(fake) });
    try {
      await expect(rig.stepFetchTurn()).rejects.toThrow(/no executed web_fetch pair/);
      expect(rig.report.some((l) => l.startsWith("turn 1 diagnostics:") && l.includes("blocks [text]") && l.includes("web_fetch pair no_server_tool_use"))).toBe(true);
      expect(rig.summary().includes(PAGE)).toBe(false);
      await expect(rig.stepReplay()).rejects.toThrow(/blocked by turn 1/);
      await expect(rig.stepPostTtlReplay()).rejects.toThrow(/blocked by turn 1/);
      await expect(rig.stepDeferredTail()).rejects.toThrow(/blocked by turn 1/);
      expect(() => rig.stepThinkingReplay()).toThrow(/blocked by turn 1/);
      expect(rig.facts.length).toBe(1);
      expect(fake.requests.length).toBe(1);
    } finally {
      rig.dispose();
    }
  });

  it("R9-hist S7b AC13 failed request: an API error on turn 1 still reports diagnostics (status, elapsed, wire facts) and sends no second request", async () => {
    const fake = makeContractFake([{ error: { status: 400, type: "invalid_request_error", message: "model: not found" } }]);
    const rig = new EchoLiveRig({ secret: "sk-ant-api-test-secret", realFetch: fake.fetch });
    try {
      await expect(rig.stepFetchTurn()).rejects.toThrow(/turn 1 failed before a response was produced/);
      expect(rig.report.some((l) => l.startsWith("turn 1 diagnostics:") && l.includes("http [400]") && l.includes("request thinking field false"))).toBe(true);
      expect(rig.facts.length).toBe(1);
    } finally {
      rig.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// LIVE: real paid calls. Skipped (with a reason naming the gate and the owner) unless ADHD_AGENT_LIVE_ECHO=1.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
liveDescribe(`R9-hist S7 AC13 -- LIVE Anthropic echo replay (${SKIP_REASON.replace("SKIPPED", "gated")})`, () => {
  let rig: EchoLiveRig | undefined;
  const live = (): EchoLiveRig => {
    check(rig !== undefined, "the live rig was not created");
    return rig;
  };

  beforeAll(() => {
    const secret = process.env["ANTHROPIC_API_KEY"];
    // Enabled but not runnable is RED, never a quiet skip.
    check(secret !== undefined && secret.length > 0, `${GATE}=1 is set but ANTHROPIC_API_KEY is missing`);
    rig = new EchoLiveRig({ secret, realFetch: globalThis.fetch.bind(globalThis) });
  });

  afterAll(() => {
    if (rig !== undefined) {
      process.stdout.write(`${rig.summary()}\n`);
      rig.dispose();
    }
  });

  it("turn 1: a real executed web_fetch turn is captured and survives a store round trip (diagnostics line first)", async () => {
    await live().stepFetchTurn();
  }, 180_000);

  it("(b)(c): replaying the real turn byte-for-byte (empty text block dropped) returns no 400", async () => {
    await live().stepReplay();
  }, 180_000);

  it("(a): the replayed thinking signatures are byte-identical (fails alone, as NOT EXERCISED, when turn 1 had no thinking block)", () => {
    live().stepThinkingReplay();
  });

  it("(e): the post-TTL shape (tier S stripped, tier T kept) returns no 400", async () => {
    await live().stepPostTtlReplay();
  }, 180_000);

  it("(d): a real pause_turn continuation completed, or the report says it was not exercised", () => {
    live().stepPauseReport();
  });

  it("(f) INFORMATIONAL, last: whether the API accepts a dangling server_tool_use tail (gates S3b)", async () => {
    await live().stepDeferredTail();
  }, 180_000);

  it("the whole run stayed inside the request cap", () => {
    expect(live().facts.length).toBeLessThanOrEqual(MAX_REQUESTS);
  });
});
