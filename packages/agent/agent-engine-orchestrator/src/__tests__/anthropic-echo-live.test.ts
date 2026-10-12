/**
 * anthropic-echo-live.test.ts -- R9-hist S7 (spec-v2 AC13, items (a)-(f)): does the LIVE Anthropic Messages API
 * accept the assistant history this package replays (thinking signatures, executed server tool pairs, tier S
 * stripped after the TTL, the deferred server_tool_use tail)? The offline contract fake encodes only the documented
 * rules; this file is the one check of what the real API enforces.
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
 *        and the API returns no 400 (`echoDegraded` absent AND no 4xx on the wire);
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

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider, redactApiMessage } from "../providers/anthropic.js";
import { partitionEcho, type EchoCaps } from "../providers/anthropic-echo.js";
import type { ProviderChatResponse } from "../providers/types.js";
import type { Message } from "../validation/index.js";
import { makeContractFake, type FakeStep, type IFakeReply } from "./fixtures/anthropic-contract-fake.js";
import { REAL_MIGRATIONS_FOLDER } from "./fixtures/real-schema-db.js";

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

const PROMPT_FETCH = "Use the web_fetch tool exactly once on https://example.com, then say in one short sentence what that page is.";
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
  assistant: IBlockFact[][];
}

export function inspectBody(body: string): IBodyFacts {
  const parsed = JSON.parse(body) as {
    model?: unknown;
    output_config?: { effort?: unknown };
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
    effort: typeof parsed.output_config?.effort === "string" ? parsed.output_config.effort : undefined,
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

interface ITurnOne {
  user: Message;
  assistant: Message;
  response: ProviderChatResponse;
  captured: Block[];
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
    check(this.turnOne !== undefined, "turn 1 did not complete, so this item cannot run");
    return this.turnOne;
  }

  /** Turn 1: one real web_fetch turn; persists user + assistant + echo through the real store, then reloads. */
  async stepFetchTurn(): Promise<void> {
    const user = message(this.sessionId, "user", PROMPT_FETCH);
    const { result: res, facts } = await this.newFacts(this.facts.length, () =>
      this.provider.chat({ messages: [user], serverSideTools: [WEB_FETCH] })
    );
    check(facts.every((f) => f.status > 0 && f.status < 400), `turn 1 was rejected by the API (statuses ${facts.map((f) => f.status).join(",")})`);
    check(res.usage?.stopReason !== "length", "turn 1 stopped on max_tokens: inconclusive, re-run");
    this.recordCalls(res);
    check(res.echo !== undefined, "turn 1 produced no replay-relevant block (no thinking and no server tool): (a)/(b) NOT EXERCISED");
    const captured = res.echo.blocks.map((b) => ({ ...b })) as Block[];
    const types = typesOf(captured);
    check(types.includes("thinking") || types.includes("redacted_thinking"), "turn 1 produced no thinking block: (a) NOT EXERCISED");
    check(types.includes("server_tool_use") && types.some((t) => t === "web_fetch_tool_result"), "turn 1 produced no executed web_fetch pair: (b) NOT EXERCISED");

    const assistant: Message = { ...res.message, sessionId: this.sessionId };
    const store = this.reopenedStore();
    store.appendMessage(this.sessionId, user);
    store.appendMessage(this.sessionId, assistant);
    const part = partitionEcho(res.echo, CAPS, store.getEchoSessionServerBytes(this.sessionId), true);
    check(part.persist !== undefined, `partitionEcho refused to persist the real echo (${part.reason ?? "no reason"})`);
    store.appendMessageEcho(assistant.id, this.sessionId, part.persist.echo, part.persist.bytes, part.persist.serverBytes);

    // Round trip: what the next reader gets is the captured echo, block for block.
    const reloaded = this.reopenedStore().getMessageEchoes(this.sessionId, [assistant.id], 60_000, TTL_MS).get(assistant.id);
    check(reloaded !== undefined, "the persisted echo could not be reloaded from a reopened store");
    check(
      sameList(reloaded.blocks.map((b) => blockFact(b as Block).hash), captured.map((b) => blockFact(b).hash)),
      "the persisted echo is not byte-identical to the captured echo after a store round trip"
    );
    this.turnOne = { user, assistant, response: res, captured };
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
    const wantSigs = want.filter((b) => b.sigHash !== undefined).map((b) => b.sigHash);
    const wireSigs = wire.filter((b) => b.sigHash !== undefined).map((b) => b.sigHash);
    check(wantSigs.length > 0 && sameList(wireSigs as string[], wantSigs as string[]), "replay: thinking signatures on the wire differ from the captured ones (a)");
    this.note(
      `(a) PASS: ${wantSigs.length} thinking signature(s) replayed byte-identical, no 400; ` +
        `(b) PASS: server pair replayed byte-identical, no 400; (c) PASS: empty text block dropped before send, request accepted; ` +
        `wire types [${wire.map((b) => b.type).join(", ")}]; statuses ${facts.map((f) => f.status).join(",")}`
    );
  }

  /** (e): tier S stripped by the store read (session idle past the TTL), tier T kept. */
  async stepPostTtlReplay(): Promise<void> {
    const t1 = this.requireTurnOne();
    const stripped = this.reopenedStore().getMessageEchoes(this.sessionId, [t1.assistant.id], TTL_MS * 2, TTL_MS).get(t1.assistant.id);
    check(stripped !== undefined, "(e): nothing is left of the echo after the tier S strip, so the post-TTL shape cannot be exercised");
    const strippedTypes = typesOf(stripped.blocks as Block[]);
    check(!strippedTypes.some(isServerBlock), "(e): the store read left tier S blocks in an expired session");
    check(strippedTypes.some((t) => t === "thinking" || t === "redacted_thinking"), "(e): the stripped echo kept no thinking block");
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
    const header = readFileSync(join(HERE, "anthropic-echo-live.test.ts"), "utf8").split("\n").slice(0, 40).join("\n");
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

  it("turn 1: a real thinking + web_fetch turn is captured and survives a store round trip", async () => {
    await live().stepFetchTurn();
  }, 180_000);

  it("(a)(b)(c): replaying the real turn byte-for-byte (empty text block dropped) returns no 400", async () => {
    await live().stepReplay();
  }, 180_000);

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
