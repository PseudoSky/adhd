/**
 * Test fixture: Anthropic Messages API streaming (SSE) reply bodies, for tests that drive the REAL
 * `AnthropicProvider` / `@anthropic-ai/sdk` against a fake fetch seam or a loopback HTTP server.
 * No test using this fixture may reach api.anthropic.com.
 *
 * Two ways to describe a reply:
 *  - the original `text` / `toolUse` params (unchanged; existing suites depend on their exact bytes), or
 *  - `blocks`, an ordered list of content blocks (thinking, redacted_thinking, text, tool_use, server_tool_use and any
 *    `*_tool_result`) emitted the way the real API streams them (R9-hist S1; shapes taken from the R8 C1 wire capture,
 *    see `./c1-wire/`): thinking opens with empty `thinking`/`signature` and fills them through `thinking_delta` /
 *    `signature_delta`, tool inputs stream through `input_json_delta`, and server tool results arrive whole in
 *    `content_block_start` with no deltas. `stopReason` may be any API stop reason, including `pause_turn`.
 *
 * `parseSseBody` is the inverse: it folds an SSE body back into blocks (used by the contract fake to learn what a
 * recorded capture emitted, and cross-checked against the real SDK's `finalMessage()` in the fixture tests).
 */
export interface ISseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** A thinking block as streamed; `thinking` is empty when the API omits the display text (Haiku 5.5 adaptive). */
export interface ISseThinkingBlock {
  type: "thinking";
  thinking?: string;
  signature: string;
}
export interface ISseRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}
export interface ISseTextBlock {
  type: "text";
  text: string;
  [extra: string]: unknown;
}
/** A client `tool_use` block (the model asks the host to run a tool). */
export interface ISseToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  [extra: string]: unknown;
}
/** A `server_tool_use` block (Anthropic runs the tool: `web_fetch`, `web_search`, ...). */
export interface ISseServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  [extra: string]: unknown;
}
/** Any server tool result (`web_fetch_tool_result`, `web_search_tool_result`, ...): complete in `content_block_start`. */
export interface ISseServerResultBlock {
  type: `${string}_tool_result`;
  tool_use_id: string;
  content: unknown;
  [extra: string]: unknown;
}
export type ISseBlock =
  | ISseThinkingBlock
  | ISseRedactedThinkingBlock
  | ISseTextBlock
  | ISseToolUseBlock
  | ISseServerToolUseBlock
  | ISseServerResultBlock;

export type SseStopReason = "end_turn" | "tool_use" | "pause_turn" | "max_tokens" | "stop_sequence" | "refusal";

export interface ISseReply {
  model: string;
  usage: ISseUsage;
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  /** Ordered content blocks. Mutually exclusive with `text` / `toolUse`. */
  blocks?: readonly ISseBlock[];
  /** Overrides the derived stop reason (`tool_use` when a client tool_use is present, else `end_turn`). */
  stopReason?: SseStopReason;
  /** `message.id` in `message_start` (default `msg_loopback`). */
  messageId?: string;
}

/** True for a server tool result block (`web_fetch_tool_result`, ...), false for the client `tool_result`. */
export function isServerResultBlock(block: { type: string }): block is ISseServerResultBlock {
  return block.type.endsWith("_tool_result");
}

const ev = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** SSE events for one block in `blocks` form, at stream position `index` (mirrors the real API's event shapes). */
function blockEvents(block: ISseBlock, index: number): string[] {
  const stop = ev("content_block_stop", { type: "content_block_stop", index });
  switch (block.type) {
    case "thinking": {
      const out = [
        ev("content_block_start", {
          type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        ev("content_block_delta", {
          type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking ?? "" },
        }),
        ev("content_block_delta", {
          type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature },
        }),
      ];
      return [...out, stop];
    }
    case "text": {
      const { text, ...rest } = block;
      return [
        ev("content_block_start", { type: "content_block_start", index, content_block: { ...rest, type: "text", text: "" } }),
        ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }),
        stop,
      ];
    }
    case "tool_use":
    case "server_tool_use": {
      const { input, ...rest } = block;
      return [
        ev("content_block_start", { type: "content_block_start", index, content_block: { ...rest, input: {} } }),
        ev("content_block_delta", {
          type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        }),
        stop,
      ];
    }
    default:
      // redacted_thinking and every `*_tool_result`: complete in the start event, no deltas.
      return [ev("content_block_start", { type: "content_block_start", index, content_block: block }), stop];
  }
}

/** The SSE text of one complete streamed assistant message. */
export function anthropicSseBody(reply: ISseReply): string {
  const { output_tokens: outTokens, ...startUsage } = reply.usage;
  const parts: string[] = [
    ev("message_start", {
      type: "message_start",
      message: {
        id: reply.messageId ?? "msg_loopback", type: "message", role: "assistant", model: reply.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { ...startUsage, output_tokens: 1 },
      },
    }),
  ];
  if (reply.blocks) {
    reply.blocks.forEach((block, i) => parts.push(...blockEvents(block, i)));
    const hasClientTool = reply.blocks.some(b => b.type === "tool_use");
    parts.push(
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: reply.stopReason ?? (hasClientTool ? "tool_use" : "end_turn"), stop_sequence: null },
        usage: { output_tokens: outTokens },
      }),
      ev("message_stop", { type: "message_stop" })
    );
    return parts.join("");
  }
  let index = 0;
  if (reply.text !== undefined) {
    parts.push(
      ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text } }),
      ev("content_block_stop", { type: "content_block_stop", index })
    );
    index++;
  }
  if (reply.toolUse) {
    parts.push(
      ev("content_block_start", {
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: reply.toolUse.id, name: reply.toolUse.name, input: {} },
      }),
      ev("content_block_delta", {
        type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input) },
      }),
      ev("content_block_stop", { type: "content_block_stop", index })
    );
  }
  parts.push(
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: reply.stopReason ?? (reply.toolUse ? "tool_use" : "end_turn"), stop_sequence: null },
      usage: { output_tokens: outTokens },
    }),
    ev("message_stop", { type: "message_stop" })
  );
  return parts.join("");
}

/** Deterministic filler of roughly `words` distinct words (distinct so the BPE cannot compress it away). */
export function distinctFiller(words: number, salt = "w"): string {
  return Array.from({ length: words }, (_, i) => `${salt}${i.toString(36)}x${(i * 7919) % 1009}`).join(" ");
}

/** One message folded out of an SSE body by {@link parseSseBody}. */
export interface IParsedSse {
  id: string;
  model: string;
  stopReason: string | null;
  usage: ISseUsage;
  content: ISseBlock[];
}

/**
 * Folds an SSE body (the real API's or {@link anthropicSseBody}'s) into the assistant message it streams. Tool inputs
 * are the JSON-parsed concatenation of their `input_json_delta`s (`{}` when empty); a thinking block carries the
 * concatenated `thinking_delta`s and the `signature_delta`. Throws on a malformed event so a corrupt fixture fails loudly.
 */
export function parseSseBody(sse: string): IParsedSse {
  const out: IParsedSse = { id: "", model: "", stopReason: null, usage: { input_tokens: 0, output_tokens: 0 }, content: [] };
  const open = new Map<number, { block: Record<string, unknown>; json: string }>();
  const unopened = (what: string, index: number): Error => new Error(`parseSseBody: ${what} for unopened block ${index}`);
  for (const chunk of sse.split("\n\n")) {
    const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
    if (!dataLine) continue;
    const d = JSON.parse(dataLine.slice(6)) as IWireEvent;
    switch (d.type) {
      case "message_start":
        out.id = d.message?.id ?? "";
        out.model = d.message?.model ?? "";
        out.usage = { ...(d.message?.usage as ISseUsage) };
        break;
      case "content_block_start":
        open.set(d.index ?? -1, { block: { ...d.content_block }, json: "" });
        break;
      case "content_block_delta": {
        const cur = open.get(d.index ?? -1);
        if (!cur) throw unopened("delta", d.index ?? -1);
        const delta = d.delta ?? {};
        const kind = delta["type"];
        if (kind === "text_delta") cur.block["text"] = `${String(cur.block["text"])}${String(delta["text"])}`;
        else if (kind === "thinking_delta") cur.block["thinking"] = `${String(cur.block["thinking"])}${String(delta["thinking"])}`;
        else if (kind === "signature_delta") cur.block["signature"] = delta["signature"];
        else if (kind === "input_json_delta") cur.json += String(delta["partial_json"]);
        else throw new Error(`parseSseBody: unknown delta ${String(kind)}`);
        break;
      }
      case "content_block_stop": {
        const cur = open.get(d.index ?? -1);
        if (!cur) throw unopened("stop", d.index ?? -1);
        if (cur.block["type"] === "tool_use" || cur.block["type"] === "server_tool_use") {
          cur.block["input"] = cur.json === "" ? {} : (JSON.parse(cur.json) as unknown);
        }
        out.content[d.index ?? -1] = cur.block as unknown as ISseBlock;
        open.delete(d.index ?? -1);
        break;
      }
      case "message_delta":
        out.stopReason = (d.delta?.["stop_reason"] as string | null | undefined) ?? null;
        out.usage = { ...out.usage, ...d.usage };
        break;
      default:
        break;
    }
  }
  if (open.size > 0) throw new Error("parseSseBody: unterminated content block");
  return out;
}

/** The subset of the wire event envelope {@link parseSseBody} reads. */
interface IWireEvent {
  type: string;
  index?: number;
  message?: { id: string; model: string; usage: Partial<ISseUsage> };
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: Partial<ISseUsage>;
}
