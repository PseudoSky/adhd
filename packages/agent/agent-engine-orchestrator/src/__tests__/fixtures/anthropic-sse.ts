/**
 * Test fixture: Anthropic Messages API streaming (SSE) reply bodies, for tests that drive the REAL
 * `AnthropicProvider` / `@anthropic-ai/sdk` against a fake fetch seam or a loopback HTTP server.
 * No test using this fixture may reach api.anthropic.com.
 */
export interface ISseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface ISseReply {
  model: string;
  usage: ISseUsage;
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
}

const ev = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The SSE text of one complete streamed assistant message. */
export function anthropicSseBody(reply: ISseReply): string {
  const { output_tokens: outTokens, ...startUsage } = reply.usage;
  const parts: string[] = [
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_loopback", type: "message", role: "assistant", model: reply.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { ...startUsage, output_tokens: 1 },
      },
    }),
  ];
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
      delta: { stop_reason: reply.toolUse ? "tool_use" : "end_turn", stop_sequence: null },
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
