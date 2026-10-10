/**
 * `tool-result-tokens.ts` — bounded token estimate for a tool result
 * (backlog d89e20f4; related 3ad735bb AC1.4).
 *
 * `gpt-tokenizer`'s `encode` is synchronous and super-linear on long
 * single-character runs (measured: 8 KB run 37 ms, 16 KB 109 ms, 32 KB 394 ms,
 * 75 KB 3.2 s alone and ~8 s under 8-way load) while ordinary prose/JSON costs
 * ~5 ms per 200 KB. Encoding the full result therefore stalled the event loop on
 * pathological tool output (binary, padding, minified blobs) before the result
 * cap ever ran.
 *
 * Contract:
 * - Results of at most {@link TOOL_RESULT_EXACT_ENCODE_MAX_CHARS} chars are encoded
 *   in full: the figure equals `encode(text).length` exactly (3ad735bb AC1.4).
 * - Longer results encode only a head sample and a tail sample, each
 *   {@link TOOL_RESULT_SAMPLE_CHARS} chars, and scale the observed tokens/char
 *   ratio to the full length. The result is flagged `estimated: true`, and the
 *   TOOL_RESULT event carries `tool_call_est_result_tokens_estimated: true`
 *   (absent when exact), mirroring how `usage_lower_bound` marks non-exact usage.
 * - The tokenizer is never handed more than 2 * TOOL_RESULT_SAMPLE_CHARS chars
 *   in the estimated path.
 *
 * Pure and process-local: no shared state, safe under concurrent processes.
 */
import { encode } from 'gpt-tokenizer';

/** Results up to this many chars are tokenized exactly (worst case ~150 ms on a pathological run). */
export const TOOL_RESULT_EXACT_ENCODE_MAX_CHARS = 20_000;

/** Chars encoded from each of the head and the tail of an oversize result. */
export const TOOL_RESULT_SAMPLE_CHARS = 4_000;

export interface IToolResultTokenEstimate {
  tokens: number;
  /** True when `tokens` was scaled from a bounded sample rather than an exact encode. */
  estimated: boolean;
}

/** Cut that never splits a UTF-16 surrogate pair at `index`. */
function safeIndex(text: string, index: number): number {
  const c = text.charCodeAt(index);
  return c >= 0xdc00 && c <= 0xdfff ? index - 1 : index;
}

/**
 * Token count for a tool result: exact up to the threshold, a bounded
 * head+tail-sample estimate above it.
 *
 * @param text the full serialized tool result
 * @param encoder tokenizer (injectable for tests); defaults to gpt-tokenizer
 */
export function estimateToolResultTokens(
  text: string,
  encoder: (s: string) => ArrayLike<number> = encode
): IToolResultTokenEstimate {
  if (text.length <= TOOL_RESULT_EXACT_ENCODE_MAX_CHARS) {
    return { tokens: encoder(text).length, estimated: false };
  }
  const headEnd = safeIndex(text, TOOL_RESULT_SAMPLE_CHARS);
  const tailStart = safeIndex(text, text.length - TOOL_RESULT_SAMPLE_CHARS);
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const sampleTokens = encoder(head).length + encoder(tail).length;
  const sampleChars = head.length + tail.length;
  return {
    tokens: Math.ceil((sampleTokens * text.length) / sampleChars),
    estimated: true,
  };
}
