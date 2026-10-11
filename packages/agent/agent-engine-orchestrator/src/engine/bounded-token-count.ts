/**
 * `bounded-token-count.ts` — the one bounded token counter every provider
 * path uses (backlog ea8f6f92 AC1; origin d89e20f4, related 3ad735bb AC1.4).
 * Extracted from `tool-result-tokens.ts` so the anthropic cache guard shares it.
 *
 * `gpt-tokenizer`'s `encode` is synchronous and super-linear on long
 * single-character runs (measured: 8 KB run 37 ms, 16 KB 109 ms, 32 KB 394 ms,
 * 75 KB 3.2 s alone and ~8 s under 8-way load) while ordinary prose/JSON costs
 * ~5 ms per 200 KB. Encoding the full result therefore stalled the event loop on
 * pathological tool output (binary, padding, minified blobs) before the result
 * cap ever ran.
 *
 * Contract:
 * - Results of at most {@link BOUNDED_COUNT_EXACT_MAX_CHARS} chars are encoded
 *   in full: the figure equals `encode(text).length` exactly (3ad735bb AC1.4).
 * - Longer results encode {@link BOUNDED_COUNT_SAMPLE_CHUNKS} equal chunks taken at
 *   evenly spaced offsets across the WHOLE text (first chunk at the head, last
 *   chunk at the tail), in total 2 * {@link BOUNDED_COUNT_SAMPLE_CHARS} chars, and
 *   scale the observed tokens/char ratio to the full length. Spreading the
 *   sample means a normal head and tail around a dense middle (base64, minified
 *   JSON) is still represented in proportion (a4235310 M5). The result is flagged `estimated: true`, and the
 *   TOOL_RESULT event carries `tool_call_est_result_tokens_estimated: true`
 *   (absent when exact), mirroring how `usage_lower_bound` marks non-exact usage.
 * - The tokenizer is never handed more than 2 * BOUNDED_COUNT_SAMPLE_CHARS chars
 *   in the estimated path, and no single call more than one chunk.
 *
 * Pure and process-local: no shared state, safe under concurrent processes.
 */
import { encode } from 'gpt-tokenizer';

/** Results up to this many chars are tokenized exactly (worst case ~150 ms on a pathological run). */
export const BOUNDED_COUNT_EXACT_MAX_CHARS = 20_000;

/**
 * Half the total sampled-char budget for an oversize result: the {@link BOUNDED_COUNT_SAMPLE_CHUNKS}
 * evenly spaced chunks together cover 2 * this many chars (name kept for API stability).
 */
export const BOUNDED_COUNT_SAMPLE_CHARS = 4_000;

/** Number of evenly spaced chunks sampled from an oversize result. */
export const BOUNDED_COUNT_SAMPLE_CHUNKS = 16;

/** Chars per sampled chunk; chunks total 2 * {@link BOUNDED_COUNT_SAMPLE_CHARS}. */
const CHUNK_CHARS = (2 * BOUNDED_COUNT_SAMPLE_CHARS) / BOUNDED_COUNT_SAMPLE_CHUNKS;

export interface IBoundedTokenCount {
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
 * Token count for arbitrary text: exact up to the threshold, a bounded
 * estimate above it, scaled from {@link BOUNDED_COUNT_SAMPLE_CHUNKS} evenly spaced chunks
 * (head, interior and tail alike).
 *
 * @param text the full text to count
 * @param encoder tokenizer (injectable for tests); defaults to gpt-tokenizer
 */
export function boundedTokenCount(
  text: string,
  encoder: (s: string) => ArrayLike<number> = encode
): IBoundedTokenCount {
  if (text.length <= BOUNDED_COUNT_EXACT_MAX_CHARS) {
    return { tokens: encoder(text).length, estimated: false };
  }
  const span = text.length - CHUNK_CHARS;
  let sampleTokens = 0;
  let sampleChars = 0;
  for (let k = 0; k < BOUNDED_COUNT_SAMPLE_CHUNKS; k++) {
    const start = safeIndex(
      text,
      Math.floor((span * k) / (BOUNDED_COUNT_SAMPLE_CHUNKS - 1))
    );
    const end = safeIndex(text, start + CHUNK_CHARS);
    const chunk = text.slice(start, end);
    sampleTokens += encoder(chunk).length;
    sampleChars += chunk.length;
  }
  return {
    tokens: Math.ceil((sampleTokens * text.length) / sampleChars),
    estimated: true,
  };
}
