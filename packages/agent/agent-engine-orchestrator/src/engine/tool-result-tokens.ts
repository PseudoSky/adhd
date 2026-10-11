/**
 * `tool-result-tokens.ts` — bounded token estimate for a tool result
 * (backlog d89e20f4; related 3ad735bb AC1.4).
 *
 * Thin delegate over {@link boundedTokenCount} (ea8f6f92 AC1), which owns the
 * contract: exact up to 20k chars, evenly spaced sampled estimate above it
 * (`estimated: true`), never handing the tokenizer more than a bounded span.
 * The TOOL_RESULT event carries `tool_call_est_result_tokens_estimated: true`
 * when the figure is sampled.
 *
 * Pure and process-local: no shared state, safe under concurrent processes.
 */
import { encode } from 'gpt-tokenizer';

import {
  BOUNDED_COUNT_EXACT_MAX_CHARS,
  BOUNDED_COUNT_SAMPLE_CHARS,
  BOUNDED_COUNT_SAMPLE_CHUNKS,
  boundedTokenCount,
  type IBoundedTokenCount,
} from './bounded-token-count.js';

/** Results up to this many chars are tokenized exactly. */
export const TOOL_RESULT_EXACT_ENCODE_MAX_CHARS = BOUNDED_COUNT_EXACT_MAX_CHARS;

/** Chars encoded from each of the head and the tail of an oversize result. */
export const TOOL_RESULT_SAMPLE_CHARS = BOUNDED_COUNT_SAMPLE_CHARS;

/** Number of evenly spaced chunks sampled from an oversize result. */
export const TOOL_RESULT_SAMPLE_CHUNKS = BOUNDED_COUNT_SAMPLE_CHUNKS;

export type IToolResultTokenEstimate = IBoundedTokenCount;

/**
 * Token count for a tool result: exact up to the threshold, a bounded
 * sampled estimate above it.
 *
 * @param text the full serialized tool result
 * @param encoder tokenizer (injectable for tests); defaults to gpt-tokenizer
 */
export function estimateToolResultTokens(
  text: string,
  encoder: (s: string) => ArrayLike<number> = encode
): IToolResultTokenEstimate {
  return boundedTokenCount(text, encoder);
}
