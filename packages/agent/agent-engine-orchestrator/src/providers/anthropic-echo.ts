/**
 * R9-hist S2a: pure helpers for Anthropic assistant-history fidelity (no I/O, no SDK client, no clock).
 *
 * The Anthropic API requires an assistant turn's `thinking` / `redacted_thinking` blocks to be passed back
 * unchanged, and runs a deferred `server_tool_use` only if that turn is sent back. `Message` carries only
 * `content` + `toolCalls`, so the provider captures `response.content` verbatim as an {@link IProviderEcho}
 * (a side record keyed by the assistant `Message.id`, never a `Message` field) and replays it.
 *
 * Two tiers of blocks (spec-v2 section 1):
 *  - tier T (continuity, never expires): `thinking`, `redacted_thinking`, `text`, client `tool_use`;
 *  - tier S (third-party bodies, expire, capped): `server_tool_use` (and the MCP-connector twin `mcp_tool_use`)
 *    plus every `*_tool_result` (`web_fetch_tool_result`, `web_search_tool_result`, ...). Tier S blocks are
 *    always handled in pairs (use + result, matched by `tool_use_id`), never partially.
 *
 * Exports: {@link captureEcho}, {@link assistantBlocks}, {@link sanitizeServerToolPairs}, {@link isEchoRejection},
 * {@link partitionEcho}, {@link stripServerBlocks}. The persistence side lives in `agent-store-runtime`; the
 * request wiring lives in `anthropic.ts`.
 */
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";

import type { IProviderEcho } from "@adhd/agent-base-types";

import type { Message, ToolCall } from "../validation/index.js";
import { isProviderCallError } from "./provider-failure.js";

/** One echoed content block: opaque JSON the API produced, never reinterpreted beyond its `type`. */
type EchoBlock = Record<string, unknown>;

/** Persistence limits for one echo (value config, not a feature switch). */
export interface EchoCaps {
  /** Largest `JSON.stringify(blocks)` byte length persisted for one assistant message. */
  maxMessageBytes: number;
  /** Soft cap on the tier S bytes persisted for a whole session (tier T is not counted). */
  maxSessionBytes: number;
  /** How long persisted tier S bodies stay replayable; `<= 0` means tier S is never persisted. */
  serverResultTtlMs: number;
}

// ─── block classification ────────────────────────────────────────────────────

const SERVER_USE_TYPES: ReadonlySet<string> = new Set(["server_tool_use", "mcp_tool_use"]);

function typeOf(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const t = (block as { type?: unknown }).type;
  return typeof t === "string" ? t : undefined;
}

/** A server-side tool invocation (`server_tool_use`, `mcp_tool_use`). */
function isServerUse(block: unknown): boolean {
  const t = typeOf(block);
  return t !== undefined && SERVER_USE_TYPES.has(t);
}

/** A tool result the provider produced itself (`web_fetch_tool_result`, ...); the client `tool_result` is NOT one. */
function isServerResult(block: unknown): boolean {
  const t = typeOf(block);
  return t !== undefined && t !== "tool_result" && t.endsWith("_tool_result");
}

/** Tier S: third-party bodies that expire and are capped. */
function isTierS(block: unknown): boolean {
  return isServerUse(block) || isServerResult(block);
}

/** Whether a block is something the legacy `text` + `tool_use` rebuild cannot reproduce. */
function isReplayRelevant(block: unknown): boolean {
  const t = typeOf(block);
  return t === "thinking" || t === "redacted_thinking" || isTierS(block);
}

function idOf(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as { id?: unknown; tool_use_id?: unknown };
  const v = isServerResult(block) ? b.tool_use_id : b.id;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

// ─── capture ─────────────────────────────────────────────────────────────────

/**
 * Capture an assistant response's content blocks verbatim (deep-cloned to plain JSON, order preserved, unknown
 * future block types kept). Returns `undefined` unless the response carries at least one block the legacy rebuild
 * cannot reproduce (`thinking`, `redacted_thinking`, `server_tool_use`, any `*_tool_result`), so a plain
 * text/`tool_use` turn costs nothing and its request bytes stay identical to today's.
 *
 * @param content `response.content` as accumulated by the SDK.
 * @param model the configured model string of the producing request (not `response.model`).
 */
export function captureEcho(content: readonly unknown[], model: string): IProviderEcho | undefined {
  const blocks: EchoBlock[] = [];
  for (const block of content) {
    if (typeOf(block) === undefined) continue;
    blocks.push(cloneJson(block as EchoBlock));
  }
  if (!blocks.some(isReplayRelevant)) return undefined;
  return { provider: "anthropic", model, blocks };
}

// ─── replay ──────────────────────────────────────────────────────────────────

/**
 * The assistant content blocks to send for `m`, built from its echo, or `undefined` when the caller must use the
 * legacy `text` + `tool_use` rebuild (no echo, another provider's echo, `echo.model !== model`, an empty echo, or an
 * echo whose client `tool_use` ids disagree with `m.toolCalls`, e.g. after the message was edited). Returning
 * `undefined` rather than rebuilding legacy blocks here keeps the fallback byte-identical to today's request
 * (R9-hist AC6): a text-only legacy turn is a bare string, not a block array.
 *
 * The blocks are emitted in captured order and otherwise untouched; the ONLY edit is `tool_use.name`, which is
 * re-qualified through `nameFor` (matched by tool call id; `input` and `id` stay as emitted) so the history names
 * equal the advertised `server__tool` names (P1-toolname). `nameFor` is supplied by the provider (it owns
 * `echoedToolName`) so this module does not import `anthropic.ts` (that would be a cycle).
 */
export function assistantBlocks(
  m: Message,
  echo: IProviderEcho | undefined,
  model: string,
  nameFor: (tc: ToolCall) => string,
): ContentBlockParam[] | undefined {
  if (echo?.provider !== "anthropic" || echo.model !== model || echo.blocks.length === 0) {
    return undefined;
  }
  const callsById = new Map<string, ToolCall>();
  for (const tc of m.toolCalls ?? []) callsById.set(tc.id, tc);

  const echoedToolUseIds = new Set<string>();
  for (const block of echo.blocks) {
    const id = typeOf(block) === "tool_use" ? idOf(block) : undefined;
    if (id !== undefined) echoedToolUseIds.add(id);
  }
  if (echoedToolUseIds.size !== callsById.size) return undefined;
  for (const id of echoedToolUseIds) if (!callsById.has(id)) return undefined;

  return echo.blocks.map((block): ContentBlockParam => {
    const copy = cloneJson(block);
    const id = typeOf(copy) === "tool_use" ? idOf(copy) : undefined;
    const tc = id === undefined ? undefined : callsById.get(id);
    if (tc !== undefined) (copy as { name?: unknown }).name = nameFor(tc);
    return copy as unknown as ContentBlockParam;
  });
}

// ─── pairing sanitizer ───────────────────────────────────────────────────────

/**
 * Make the server-tool blocks of a request history pair up, so a history windowed or compacted in the middle of a
 * pair (or a stale echo) can never produce an API 400. Pure; messages that need no change are returned by
 * reference. Rules (assistant messages only; thinking and every other block are never touched):
 *  - drop a `*_tool_result` whose `tool_use_id` has no PRECEDING `server_tool_use` (orphan), and any repeated result
 *    for the same id (duplicate);
 *  - drop a `server_tool_use` that has no result block anywhere after it (dangling: today's behaviour for a fetch
 *    the API deferred; the pending-tail exception is a separate, live-gated change);
 *  - an assistant message left with no blocks is removed.
 */
export function sanitizeServerToolPairs(messages: MessageParam[]): MessageParam[] {
  // Pass 1: flatten positions of server blocks across assistant messages.
  let pos = 0;
  const firstUse = new Map<string, number>();
  const results: Array<{ id: string | undefined; pos: number }> = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown[]) {
      pos += 1;
      if (isServerUse(block)) {
        const id = idOf(block);
        if (id !== undefined && !firstUse.has(id)) firstUse.set(id, pos);
      } else if (isServerResult(block)) {
        results.push({ id: idOf(block), pos });
      }
    }
  }
  // The one valid result per id: the first result positioned after its use.
  const validResultPos = new Map<string, number>();
  for (const r of results) {
    if (r.id === undefined) continue;
    const usePos = firstUse.get(r.id);
    if (usePos !== undefined && r.pos > usePos && !validResultPos.has(r.id)) validResultPos.set(r.id, r.pos);
  }

  // Pass 2: rebuild.
  pos = 0;
  const out: MessageParam[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const kept: unknown[] = [];
    let changed = false;
    for (const block of message.content as unknown[]) {
      pos += 1;
      let keep = true;
      if (isServerUse(block)) {
        const id = idOf(block);
        keep = id !== undefined && firstUse.get(id) === pos && validResultPos.has(id);
      } else if (isServerResult(block)) {
        const id = idOf(block);
        keep = id !== undefined && validResultPos.get(id) === pos;
      }
      if (keep) kept.push(block);
      else changed = true;
    }
    if (!changed) out.push(message);
    else if (kept.length > 0) out.push({ ...message, content: kept as ContentBlockParam[] });
  }
  return out;
}

// ─── degrade matcher ─────────────────────────────────────────────────────────

const ECHO_REJECTION_RE = /thinking|signature|redacted|server_tool_use|tool_use_id|tool_result|web_fetch|web_search/i;
const CONTEXT_LENGTH_RE = /prompt is too long|context.?length|too many tokens|exceeds.*(context|maximum)/i;

/**
 * Whether `err` is the API rejecting the replayed history (so the caller may retry once without echoes): a
 * {@link ProviderCallError} of class `invalid_request` whose text names an echoed block type, and which is NOT a
 * length rejection. A context-length failure with echo present is not an echo fault; it keeps the engine's
 * `CONTEXT_WINDOW_EXCEEDED` handling and must not disable echo. 429 / 5xx / abort / non-provider errors are never
 * echo rejections.
 */
export function isEchoRejection(err: unknown): boolean {
  if (!isProviderCallError(err)) return false;
  if (err.data.class !== "invalid_request") return false;
  const text = `${err.message}\n${err.data.message ?? ""}`;
  if (CONTEXT_LENGTH_RE.test(text)) return false;
  return ECHO_REJECTION_RE.test(text);
}

// ─── persistence partition ───────────────────────────────────────────────────

/** Remove every tier S block (`server_tool_use` and all `*_tool_result`) from an echo; pure, pairs go whole. */
export function stripServerBlocks(echo: IProviderEcho): IProviderEcho {
  if (!echo.blocks.some(isTierS)) return echo;
  return { ...echo, blocks: echo.blocks.filter(b => !isTierS(b)) };
}

/** The result of {@link partitionEcho}. */
export interface IEchoPartition {
  /** What to store; absent when nothing worth keeping remains. */
  persist?: { echo: IProviderEcho; bytes: number; serverBytes: number };
  /** Why tier S (or the whole echo) was cut; absent when the echo is stored exactly as captured. */
  reason?: "over_message_cap" | "session_cap" | "server_dropped";
}

interface IServerUnit {
  /** Indices (into the echo blocks) of the use and its result(s). */
  indices: number[];
  bytes: number;
}

/** Group tier S blocks into pairs by `tool_use_id`; a block with no partner is its own unit. */
function serverUnits(blocks: readonly EchoBlock[]): IServerUnit[] {
  const byId = new Map<string, IServerUnit>();
  const units: IServerUnit[] = [];
  blocks.forEach((block, index) => {
    if (!isTierS(block)) return;
    const id = idOf(block);
    let unit = id === undefined ? undefined : byId.get(id);
    if (unit === undefined) {
      unit = { indices: [], bytes: 0 };
      units.push(unit);
      if (id !== undefined) byId.set(id, unit);
    }
    unit.indices.push(index);
    unit.bytes += byteLength(block);
  });
  return units;
}

/**
 * Decide what part of a freshly captured echo is persisted for one assistant message (pure, no I/O).
 *
 * - `bytes` is `Buffer.byteLength(JSON.stringify(blocks))` of the stored array; `serverBytes` is the tier S part.
 * - Tier S is dropped whole (never half a pair) when `persistServer` is false or `caps.serverResultTtlMs <= 0`
 *   (reason `server_dropped`); the largest pairs are dropped first until the message fits `maxMessageBytes`
 *   (reason `over_message_cap`); and ALL of the message's tier S is dropped when it would push the session past
 *   `maxSessionBytes` (reason `session_cap`). Tier T keeps persisting in every one of those cases.
 * - If tier T alone exceeds `maxMessageBytes`, nothing is persisted for this message (reason `over_message_cap`;
 *   the message replays from the legacy rebuild in later tasks).
 * - If nothing replay-relevant remains after cutting (no thinking, no tier S), nothing is persisted.
 *
 * The live run's in-memory echo is the caller's; it is never capped here.
 */
export function partitionEcho(
  echo: IProviderEcho,
  caps: EchoCaps,
  sessionServerBytes: number,
  persistServer: boolean,
): IEchoPartition {
  const blocks = echo.blocks;
  const allowServer = persistServer && caps.serverResultTtlMs > 0;
  const units = serverUnits(blocks);
  const dropped = new Set<number>();
  let reason: IEchoPartition["reason"];

  const markDropped = (unit: IServerUnit): void => {
    for (const i of unit.indices) dropped.add(i);
  };
  const project = (): EchoBlock[] => blocks.filter((_, i) => !dropped.has(i));

  if (units.length > 0 && !allowServer) {
    units.forEach(markDropped);
    reason = "server_dropped";
  }

  // Tier T alone over the per-message cap: nothing persists for this message.
  const tierT = blocks.filter(b => !isTierS(b));
  if (byteLength(tierT) > caps.maxMessageBytes) return { reason: "over_message_cap" };

  // Trim whole pairs, largest first, until the message fits.
  if (byteLength(project()) > caps.maxMessageBytes) {
    const live = units.filter(u => !dropped.has(u.indices[0] as number)).sort((a, b) => b.bytes - a.bytes || (b.indices[0] as number) - (a.indices[0] as number));
    for (const unit of live) {
      if (byteLength(project()) <= caps.maxMessageBytes) break;
      markDropped(unit);
      reason = reason ?? "over_message_cap";
    }
  }

  // Session cap on tier S: all of this message's tier S or none.
  const keptServerBytes = (): number => blocks.reduce((sum, b, i) => (isTierS(b) && !dropped.has(i) ? sum + byteLength(b) : sum), 0);
  if (keptServerBytes() > 0 && sessionServerBytes + keptServerBytes() > caps.maxSessionBytes) {
    units.forEach(markDropped);
    reason = "session_cap";
  }

  const kept = project();
  if (!kept.some(isReplayRelevant)) return reason === undefined ? {} : { reason };
  const result: IEchoPartition = {
    persist: { echo: { ...echo, blocks: kept }, bytes: byteLength(kept), serverBytes: keptServerBytes() },
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}
