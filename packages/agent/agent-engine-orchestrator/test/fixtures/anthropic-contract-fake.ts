/**
 * R9-hist S1: an offline CONTRACT FAKE of the Anthropic Messages API (`POST /v1/messages`, streaming), for tests that
 * drive the real `AnthropicProvider` / `@anthropic-ai/sdk` through the engine's `wire.fetch` seam.
 *
 * NO network, NO provider call, NO clock: `makeContractFake(script).fetch` answers from a script and validates every
 * request body against the history rules the API documents. A provider that sends an invalid history gets the same
 * HTTP 400 `invalid_request_error` the real API returns, so a mistake in echo / replay / sanitize code fails a default-
 * running CI test instead of a paid live run. (The fake encodes the documented rules; it cannot prove the rules are
 * what the live API enforces. The gated live test `anthropic-echo-live.e2e.test.ts` (S7) is the only check of that.)
 *
 * Validators (each has a rejecting negative control in `anthropic-contract-fake.test.ts`):
 *  - V1  every client `tool_use` has a `tool_result` for its id in the immediately following user turn.
 *  - V2  a `server_tool_use` must be resolved: its `*_tool_result` follows it in the same assistant message, or opens
 *        the NEXT assistant message (the deferred shape). A `server_tool_use` with no result is accepted ONLY as the
 *        pending tail of the LAST assistant message followed by a user turn made solely of `tool_result` blocks (docs,
 *        "Mixing server tools and client tools"); the fake then starts its next response with the matching
 *        `*_tool_result` block (it executes the fetch). That deferred-result shape is synthesized from the docs: the
 *        R8 C1 capture never contains it, because arm C dropped the tail.
 *  - V3  a result (client `tool_result` or server `*_tool_result`) with an unknown or duplicate `tool_use_id`, and a
 *        duplicate `tool_use` / `server_tool_use` id, is rejected.
 *  - V4a a thinking / redacted_thinking block that is present but not byte-identical to what the fake emitted, or is
 *        reordered / partial / forged (unknown signature), is rejected. Always on: this is the documented
 *        "pass thinking blocks back unchanged" rule.
 *  - V4b an assistant turn the fake emitted WITH thinking, present in the request WITHOUT it, is rejected. Default on;
 *        scripts that model an intentional degrade or post-compaction history set `allowThinkingOmission` (the real API
 *        tolerates omission on adaptive models, so this is the strict side). Only turns actually present in the request
 *        are checked (identified by the tool_use ids / text the fake emitted), so a compacted-away turn imposes nothing.
 *  - V5  every body is recorded in order, rejected ones included (`fake.requests`, raw string + parsed), and a body
 *        that is not a well-formed Messages request (not JSON, no `messages`, first turn not `user`, ...) is rejected.
 *
 * Scope notes for consumers: (1) the thinking registry (what V4a/V4b compare against) belongs to ONE fake instance, so a
 * test that spans several tasks / a store reopen must keep using the same fake or the replayed thinking reads as forged;
 * (2) real API rules the fake does NOT enforce: non-empty text blocks, `tool_result` blocks first within a user turn,
 * tool-name membership in `tools`, cache_control limits; a 200 here is therefore evidence about V1-V5 only;
 * (3) fake-usage problems (unknown endpoint, non-streaming request, exhausted script) answer 404 / 501 / 500 and are
 * listed in `fake.faults`, never in `rejections()`: assert `faults` is empty.
 *
 * Like the real API, consecutive same-role messages are merged before V1-V4 are applied (the provider emits one
 * user message per tool result).
 *
 * Scripted replies: an array of steps (consumed by ACCEPTED request, in order; past the end the fake answers 500 and
 * records a fault) or a function receiving `{index, body, history}` so a scripted "model" can react to what is
 * visible (e.g. re-issue `web_fetch` when the page is not in context). A step is a reply (`blocks`, `stopReason`
 * incl. `pause_turn`, `usage`) or an injected error (`error: {status, type, message}`; 400 `invalid_request_error`
 * with caller-chosen text, 429, 529, ...). A server tool use the step leaves without a result is executed inline when the
 * step has no client tool_use, and deferred (executed by the fake on the next request) when it has one.
 *
 * `loadC1Wire` / `c1Reply` give access to the sanitized R8 C1 wire captures in `./c1-wire/`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  anthropicSseBody,
  isServerResultBlock,
  parseSseBody,
  type ISseBlock,
  type ISseServerResultBlock,
  type ISseServerToolUseBlock,
  type ISseToolUseBlock,
  type ISseUsage,
  type SseStopReason,
} from "./anthropic-sse.js";

// ---------------------------------------------------------------------------------------------------------------
// Wire shapes (request side)

/** A content block as it appears in a request body (loose: the fake must be able to inspect anything a provider sends). */
export interface IApiBlock {
  type: string;
  [key: string]: unknown;
}
export interface IApiMessage {
  role: string;
  content: string | IApiBlock[];
}
export interface IMessagesRequestBody {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: unknown;
  tools?: unknown[];
  messages: IApiMessage[];
  [key: string]: unknown;
}
/** A request message after same-role merging: `blocks` is always an array. */
export interface INormalizedMessage {
  role: "user" | "assistant";
  blocks: IApiBlock[];
}

export type ContractRule = "V1" | "V2" | "V3" | "V4a" | "V4b" | "V5";
export interface IContractViolation {
  rule: ContractRule;
  message: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Script shapes

export interface IFakeReply {
  blocks: readonly ISseBlock[];
  stopReason?: SseStopReason;
  usage?: ISseUsage;
  model?: string;
}
export interface IFakeError {
  error: { status: number; type: string; message: string; headers?: Record<string, string> };
}
export type FakeStep = IFakeReply | IFakeError;

export interface IVisibleServerUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** A result for this id is visible somewhere in the request history. */
  resolved: boolean;
}
export interface IVisibleServerResult {
  toolUseId: string;
  type: string;
  /** `content.url` of a `web_fetch_result` (absent for errors / other tools). */
  url?: string;
  text: string;
}
/** What a scripted model can "see": the request history, with the helpers the R9 scripts need. */
export interface IVisibleHistory {
  readonly messages: readonly INormalizedMessage[];
  /** True when `needle` occurs anywhere in the serialized history (page text, signatures, ids). */
  contains(needle: string): boolean;
  serverToolUses(): IVisibleServerUse[];
  serverResults(): IVisibleServerResult[];
  /** True when a non-error `web_fetch_tool_result` for `url` is visible. */
  isUrlInContext(url: string): boolean;
  fetchedUrls(): string[];
}
export interface IFakeContext {
  /** 0-based index over ALL requests (accepted or rejected), the same index as `fake.requests`. */
  index: number;
  body: IMessagesRequestBody;
  history: IVisibleHistory;
  /** Deferred server results the fake prepends to this response (the fetches it executes now). */
  deliveredServerResults: readonly ISseServerResultBlock[];
}
export type FakeScript = readonly FakeStep[] | ((ctx: IFakeContext) => FakeStep);

export interface IContractFakeOptions {
  /**
   * Models an intentional degrade / post-compaction history: V4b off (V4a stays on). A function decides per request
   * (`index` counts every request, as `fake.requests`), so a test can be strict before a degrade and lenient after it.
   */
  allowThinkingOmission?: boolean | ((ctx: { index: number }) => boolean);
  /** Builds the server result the fake returns for a server tool use. Default: {@link defaultServerResult}. */
  serverResult?: (use: { id: string; name: string; input: Record<string, unknown> }) => ISseServerResultBlock;
  model?: string;
  usage?: ISseUsage;
}

export interface IEmittedTurn {
  /** Index into `fake.requests` of the request this turn answered. */
  requestIndex: number;
  blocks: readonly ISseBlock[];
  thinking: readonly ISseBlock[];
}
export interface IDeferredServerUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  emittedAtRequest: number;
  /** Request index whose response carried the result; undefined while still pending (the defect: it never ran). */
  deliveredAtRequest?: number;
}
export interface IRecordedRequest {
  index: number;
  url: string;
  method: string;
  /** Exactly the bytes the client sent. */
  rawBody: string;
  /** Undefined only when `rawBody` is not JSON. */
  body?: IMessagesRequestBody;
  violations: IContractViolation[];
  status: number;
  /** Blocks of the assistant message the fake streamed back (accepted `reply` steps only). */
  emitted?: readonly ISseBlock[];
}
export interface IContractFake {
  /** The `wire.fetch` seam. */
  fetch: typeof fetch;
  /** V5: every request, in order, rejected ones included. */
  readonly requests: readonly IRecordedRequest[];
  /** Parsed bodies of every request (rejected ones included). */
  bodies(): IMessagesRequestBody[];
  /** Flattened violations across all requests. */
  rejections(): Array<IContractViolation & { requestIndex: number }>;
  readonly emittedTurns: readonly IEmittedTurn[];
  readonly deferred: readonly IDeferredServerUse[];
  /** Fake-usage problems (script exhausted, unsupported endpoint / non-streaming): a test must assert this is empty. */
  readonly faults: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Request normalization + visible history

const blocksOf = (content: string | IApiBlock[]): IApiBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content.map(b => ({ ...b }));

/** Merges consecutive same-role messages (the API's documented behavior) and expands string content. */
export function normalizeMessages(messages: readonly IApiMessage[]): INormalizedMessage[] {
  const out: INormalizedMessage[] = [];
  for (const m of messages) {
    const role = m.role as "user" | "assistant";
    const last = out[out.length - 1];
    if (last && last.role === role) last.blocks.push(...blocksOf(m.content));
    else out.push({ role, blocks: blocksOf(m.content) });
  }
  return out;
}

/** SSE-side blocks are structurally the wire blocks; this is the one place the nominal gap is bridged. */
export const toApiBlocks = (blocks: readonly ISseBlock[]): IApiBlock[] => blocks as unknown as IApiBlock[];

const idOf = (b: IApiBlock): string => String(b["id"] ?? "");
const useIdOf = (b: IApiBlock): string => String(b["tool_use_id"] ?? "");

function fetchUrlOf(b: IApiBlock): string | undefined {
  const c = b["content"] as { type?: string; url?: string } | undefined;
  return c && !Array.isArray(c) && c.type === "web_fetch_result" ? c.url : undefined;
}

/** Builds the {@link IVisibleHistory} of a request's messages. */
export function visibleHistory(messages: readonly INormalizedMessage[]): IVisibleHistory {
  const results = (): IVisibleServerResult[] =>
    messages
      .flatMap(m => m.blocks)
      .filter(b => isServerResultBlock(b))
      .map(b => ({
        toolUseId: useIdOf(b),
        type: b.type,
        ...(fetchUrlOf(b) !== undefined ? { url: fetchUrlOf(b) as string } : {}),
        text: JSON.stringify(b["content"]),
      }));
  return {
    messages,
    contains: needle => JSON.stringify(messages).includes(needle),
    serverToolUses: () => {
      const resolved = new Set(results().map(r => r.toolUseId));
      return messages
        .flatMap(m => m.blocks)
        .filter(b => b.type === "server_tool_use")
        .map(b => ({
          id: idOf(b),
          name: String(b["name"] ?? ""),
          input: (b["input"] ?? {}) as Record<string, unknown>,
          resolved: resolved.has(idOf(b)),
        }));
    },
    serverResults: results,
    isUrlInContext: url => results().some(r => r.url === url),
    fetchedUrls: () => results().flatMap(r => (r.url !== undefined ? [r.url] : [])),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (V1-V5)

interface IValidationState {
  emittedTurns: readonly IEmittedTurn[];
  allowThinkingOmission: boolean;
}
export interface IValidation {
  violations: IContractViolation[];
  messages: INormalizedMessage[];
  /** `server_tool_use` blocks with no result that sit in the accepted pending-tail position. */
  pendingTail: IApiBlock[];
}

const isThinking = (b: IApiBlock): boolean => b.type === "thinking" || b.type === "redacted_thinking";
const isToolResult = (b: IApiBlock): boolean => b.type === "tool_result";
const textOf = (blocks: readonly { type: string }[]): string =>
  blocks.map(b => ((b as { type: string; text?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");

/** V5: structural well-formedness of a Messages request. Returns violations (empty when well-formed). */
function checkShape(body: unknown): IContractViolation[] {
  const v = (message: string): IContractViolation[] => [{ rule: "V5", message }];
  if (typeof body !== "object" || body === null || Array.isArray(body)) return v("request body must be a JSON object");
  const b = body as Partial<IMessagesRequestBody>;
  if (typeof b.model !== "string" || b.model === "") return v("model: field required");
  if (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 1) {
    return v("max_tokens: must be a positive integer");
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) return v("messages: at least one message is required");
  for (const [i, m] of b.messages.entries()) {
    if (typeof m !== "object" || m === null) return v(`messages.${i}: must be an object`);
    if (m.role !== "user" && m.role !== "assistant") return v(`messages.${i}.role: must be "user" or "assistant"`);
    if (typeof m.content !== "string" && !Array.isArray(m.content)) return v(`messages.${i}.content: must be a string or an array of blocks`);
  }
  if (b.messages[0]?.role !== "user") return v("messages.0.role: the first message must use the user role");
  return [];
}

/** Applies V1-V5 to a parsed request body. Pure; exported so rules can be exercised without a fetch round trip. */
export function validateMessagesRequest(body: unknown, state: IValidationState): IValidation {
  const shape = checkShape(body);
  if (shape.length > 0) return { violations: shape, messages: [], pendingTail: [] };
  const messages = normalizeMessages((body as IMessagesRequestBody).messages);
  const violations: IContractViolation[] = [];
  const add = (rule: ContractRule, message: string): number => violations.push({ rule, message });

  const seenUse = new Set<string>();
  const clientUseIds: Array<Set<string>> = messages.map(() => new Set<string>());
  const serverUses = new Map<string, { msg: number; idx: number; resolved: boolean }>();
  const seenClientResults = new Set<string>();

  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      m.blocks.forEach((b, idx) => {
        if (b.type === "tool_use" || b.type === "server_tool_use") {
          const id = idOf(b);
          if (seenUse.has(id)) add("V3", `${b.type} id "${id}" is not unique`);
          seenUse.add(id);
          if (b.type === "tool_use") clientUseIds[i]!.add(id);
          else serverUses.set(id, { msg: i, idx, resolved: false });
        } else if (isServerResultBlock(b)) {
          const id = useIdOf(b);
          const use = serverUses.get(id);
          if (!use || !(use.msg === i ? use.idx < idx : use.msg === i - 2)) {
            add("V3", `${b.type}: unknown tool_use_id "${id}" (no preceding server_tool_use in this message or the previous assistant message)`);
          } else if (use.resolved) {
            add("V3", `${b.type}: duplicate result for tool_use_id "${id}"`);
          } else {
            use.resolved = true;
          }
        }
      });
      // V1: each client tool_use needs its tool_result in the very next user turn.
      const need = clientUseIds[i]!;
      if (need.size > 0) {
        const next = messages[i + 1];
        const have = new Set(next?.role === "user" ? next.blocks.filter(isToolResult).map(useIdOf) : []);
        for (const id of need) {
          if (!have.has(id)) add("V1", `tool_use id "${id}" has no tool_result block in the next user message`);
        }
      }
    } else {
      const prevIds = i > 0 ? clientUseIds[i - 1]! : new Set<string>();
      for (const b of m.blocks.filter(isToolResult)) {
        const id = useIdOf(b);
        if (!prevIds.has(id)) add("V3", `tool_result: unknown tool_use_id "${id}" (no matching tool_use in the previous assistant message)`);
        else if (seenClientResults.has(id)) add("V3", `tool_result: duplicate tool_use_id "${id}"`);
        seenClientResults.add(id);
      }
    }
  });

  // V2: unresolved server_tool_use is legal only as the pending tail of the last assistant message.
  const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
  const pendingTail: IApiBlock[] = [];
  for (const [id, use] of serverUses) {
    if (use.resolved) continue;
    const next = messages[use.msg + 1];
    const toolResultOnly = next?.role === "user" && next.blocks.length > 0 && next.blocks.every(isToolResult);
    if (use.msg === lastAssistant && toolResultOnly) pendingTail.push(messages[use.msg]!.blocks[use.idx]!);
    else {
      add(
        "V2",
        `server_tool_use "${id}" has no result: it may only be the pending tail of the last assistant message followed by a user turn of only tool_result blocks`
      );
    }
  }

  // V4: thinking blocks.
  const emittedThinking = state.emittedTurns.flatMap(t => toApiBlocks(t.thinking));
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const present = m.blocks.filter(isThinking);
    const forged = present.find(b => !emittedThinking.some(e => isDeepStrictEqual(e, b)));
    if (forged) {
      add("V4a", `messages.${i}: ${forged.type} block does not match any block the model returned (modified or forged signature)`);
      return;
    }
    const turn = matchTurn(m.blocks, state.emittedTurns);
    if (!turn) return;
    if (isDeepStrictEqual(present, turn.thinking)) return;
    if (present.length === 0) {
      if (!state.allowThinkingOmission) {
        add("V4b", `messages.${i}: assistant turn lost its ${turn.thinking.length} thinking block(s); they must be passed back unmodified`);
      }
    } else {
      add("V4a", `messages.${i}: thinking blocks were reordered, dropped in part or duplicated relative to the model's response`);
    }
  });

  return { violations, messages, pendingTail };
}

/** Identity keys of a block list: role-prefixed ids, so a turn that merely carries a RESULT is not confused with the one that made the CALL. */
function keysOf(blocks: readonly { type: string }[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of blocks) {
    const b = raw as IApiBlock;
    if (b.type === "tool_use" || b.type === "server_tool_use") keys.add(`use:${idOf(b)}`);
    else if (isServerResultBlock(b)) keys.add(`res:${useIdOf(b)}`);
  }
  return keys;
}

function matchTurn(blocks: readonly IApiBlock[], turns: readonly IEmittedTurn[]): IEmittedTurn | undefined {
  const mine = keysOf(blocks);
  let best: IEmittedTurn | undefined;
  let bestScore = 0;
  for (const t of turns) {
    const theirs = keysOf(t.blocks);
    let score = 0;
    for (const k of mine) if (theirs.has(k)) score++;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  if (best) return best;
  if (mine.size > 0) return undefined;
  const text = textOf(blocks);
  if (text === "") return undefined;
  return turns.find(t => keysOf(t.blocks).size === 0 && textOf(t.blocks) === text);
}

// ---------------------------------------------------------------------------------------------------------------
// Server results the fake "executes"

/** A complete `web_fetch_tool_result` block for `url` whose page text is `text`. */
export function webFetchResultBlock(toolUseId: string, url: string, text: string): ISseServerResultBlock {
  return {
    type: "web_fetch_tool_result",
    tool_use_id: toolUseId,
    content: {
      type: "web_fetch_result",
      url,
      retrieved_at: "2026-01-01T00:00:00.000000+00:00",
      content: { type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: url },
    },
    caller: { type: "direct" },
  };
}

/** The result the fake returns for a server tool use unless `options.serverResult` overrides it. */
export function defaultServerResult(use: { id: string; name: string; input: Record<string, unknown> }): ISseServerResultBlock {
  if (use.name === "web_fetch") {
    const url = String(use.input["url"] ?? "https://fixture.invalid/");
    return webFetchResultBlock(use.id, url, `FIXTURE-PAGE-BODY(${url})`);
  }
  if (use.name === "web_search") {
    return {
      type: "web_search_tool_result",
      tool_use_id: use.id,
      content: [{ type: "web_search_result", url: "https://fixture.invalid/hit", title: "hit", encrypted_content: "SYNTHETIC", page_age: null }],
    };
  }
  return { type: `${use.name}_tool_result`, tool_use_id: use.id, content: `FIXTURE-RESULT(${use.name})` };
}

// ---------------------------------------------------------------------------------------------------------------
// The fake

const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_USAGE: ISseUsage = { input_tokens: 10, output_tokens: 5 };

const errorResponse = (status: number, type: string, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function bodyText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "";
}

/** Makes the fake. See the file header for the contract and script semantics. */
export function makeContractFake(script: FakeScript, options: IContractFakeOptions = {}): IContractFake {
  const requests: IRecordedRequest[] = [];
  const emittedTurns: IEmittedTurn[] = [];
  const deferred: IDeferredServerUse[] = [];
  const faults: string[] = [];
  const serverResult = options.serverResult ?? defaultServerResult;
  let accepted = 0;

  const respond = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = requestUrl(input);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const rawInit = init?.body ?? (typeof input === "object" && "text" in input ? await input.text() : undefined);
    const rawBody = bodyText(rawInit);
    const index = requests.length;
    const record: IRecordedRequest = { index, url, method, rawBody, violations: [], status: 0 };
    requests.push(record);
    const finish = (res: Response): Response => {
      record.status = res.status;
      return res;
    };

    if (method !== "POST" || new URL(url, "http://fake.invalid").pathname !== "/v1/messages") {
      faults.push(`unsupported endpoint ${method} ${url} (the fake serves POST /v1/messages only)`);
      return finish(errorResponse(404, "not_found_error", `contract fake: no route for ${method} ${url}`));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
      record.body = parsed as IMessagesRequestBody;
    } catch {
      record.violations.push({ rule: "V5", message: "request body is not valid JSON" });
      return finish(errorResponse(400, "invalid_request_error", "V5: request body is not valid JSON"));
    }

    const omission = options.allowThinkingOmission;
    const validation = validateMessagesRequest(parsed, {
      emittedTurns,
      allowThinkingOmission: typeof omission === "function" ? omission({ index }) : omission === true,
    });
    record.violations.push(...validation.violations);
    if (validation.violations.length > 0) {
      const first = validation.violations[0]!;
      return finish(errorResponse(400, "invalid_request_error", `${first.rule}: ${first.message}`));
    }
    const body = parsed as IMessagesRequestBody;
    if (body.stream !== true) {
      faults.push("non-streaming request: the contract fake serves stream:true only");
      return finish(errorResponse(501, "api_error", "contract fake: only streaming requests are supported"));
    }

    // Execute the fetches the previous turn deferred: their results open this response.
    const delivered: ISseServerResultBlock[] = validation.pendingTail.map(use => {
      const entry = deferred.find(d => d.id === idOf(use));
      if (entry) entry.deliveredAtRequest = index;
      return serverResult({ id: idOf(use), name: String(use["name"] ?? ""), input: (use["input"] ?? {}) as Record<string, unknown> });
    });

    // The scripted model sees the history it answers INCLUDING the deferred results the fake executes for it now.
    const history = visibleHistory(
      delivered.length > 0 ? [...validation.messages, { role: "assistant", blocks: toApiBlocks(delivered) }] : validation.messages
    );
    const stepIndex = accepted++;
    const step: FakeStep | undefined =
      typeof script === "function" ? script({ index, body, history, deliveredServerResults: delivered }) : script[stepIndex];
    if (!step) {
      faults.push(`script exhausted at accepted request #${stepIndex} (request index ${index})`);
      return finish(errorResponse(500, "api_error", "contract fake: script exhausted"));
    }
    if ("error" in step) {
      const e = step.error;
      return finish(errorResponse(e.status, e.type, e.message, e.headers));
    }

    // Compose the assistant message: delivered deferred results first, then the step's blocks with inline server tools executed.
    const hasClientTool = step.blocks.some(b => b.type === "tool_use");
    const resolvedInStep = new Set(step.blocks.filter(isServerResultBlock).map(b => b.tool_use_id));
    const blocks: ISseBlock[] = [...delivered];
    for (const b of step.blocks) {
      blocks.push(b);
      if (b.type !== "server_tool_use" || resolvedInStep.has(b.id)) continue;
      const use = b as ISseServerToolUseBlock;
      if (hasClientTool) deferred.push({ id: use.id, name: use.name, input: use.input, emittedAtRequest: index });
      else blocks.push(serverResult({ id: use.id, name: use.name, input: use.input }));
    }
    record.emitted = blocks;
    emittedTurns.push({ requestIndex: index, blocks, thinking: blocks.filter(b => b.type === "thinking" || b.type === "redacted_thinking") });
    const reply: ISseReplyArgs = {
      model: step.model ?? options.model ?? DEFAULT_MODEL,
      usage: step.usage ?? options.usage ?? DEFAULT_USAGE,
      blocks,
      messageId: `msg_fake_${String(index).padStart(3, "0")}`,
      ...(step.stopReason ? { stopReason: step.stopReason } : {}),
    };
    return finish(new Response(anthropicSseBody(reply), { status: 200, headers: { "content-type": "text/event-stream" } }));
  };

  return {
    fetch: respond as typeof fetch,
    requests,
    bodies: () => requests.flatMap(r => (r.body ? [r.body] : [])),
    rejections: () => requests.flatMap(r => r.violations.map(v => ({ ...v, requestIndex: r.index }))),
    emittedTurns,
    deferred,
    faults,
  };
}

type ISseReplyArgs = Parameters<typeof anthropicSseBody>[0];

// ---------------------------------------------------------------------------------------------------------------
// Sanitized R8 C1 wire captures

/**
 * The captured responses in `./c1-wire/` (R8 arm C1, model claude-haiku-5-5, source
 * `tmp/agent-mcp/parity/R8/live/out/runs/C1/logs/wire/proxy-C-anthropic.jsonl`, `raw_response` rows, `bodyText` only).
 * Ids, signatures and the fetch timestamp are replaced by deterministic synthetic values of the same shape; request
 * headers are not part of the log and nothing from them is present. Shapes (block order, interleaved thinking, an
 * empty-display thinking block carrying a signature, a deferred `server_tool_use` beside client tool_use blocks) are real.
 */
export const C1_WIRE = {
  /** thinking, text, 2 client tool_use, then a `server_tool_use` (web_fetch) with NO result: the deferred shape. */
  seq02DeferredServerToolUse: "c1-seq02-deferred-server-tool-use.sse",
  /** 2 client tool_use, no thinking, no server blocks: the response that followed the dropped tail (bare tool name included). */
  seq03AfterDroppedTail: "c1-seq03-after-dropped-tail.sse",
  /** thinking, text, executed web_fetch pair, thinking, text, client tool_use. */
  seq04ExecutedPairWithThinking: "c1-seq04-executed-pair-with-thinking.sse",
  /** thinking, executed web_fetch pair, thinking, 2 client tool_use. */
  seq05ExecutedPairTwoClients: "c1-seq05-executed-pair-two-clients.sse",
} as const;
export type C1WireName = keyof typeof C1_WIRE;

/** The raw SSE text of a C1 capture. */
export function loadC1Wire(name: C1WireName): string {
  return readFileSync(fileURLToPath(new URL(`./c1-wire/${C1_WIRE[name]}`, import.meta.url)), "utf8");
}

/** A C1 capture as a scripted reply (blocks, stop reason, usage and model as captured). */
export function c1Reply(name: C1WireName): IFakeReply {
  const parsed = parseSseBody(loadC1Wire(name));
  return {
    blocks: parsed.content,
    ...(parsed.stopReason ? { stopReason: parsed.stopReason as SseStopReason } : {}),
    usage: parsed.usage,
    model: parsed.model,
  };
}

/** Narrowing helper for tests: the client `tool_use` blocks of a reply. */
export const clientToolUses = (blocks: readonly ISseBlock[]): ISseToolUseBlock[] =>
  blocks.filter((b): b is ISseToolUseBlock => b.type === "tool_use");
