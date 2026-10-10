/**
 * `tool-result-cap.ts` — bounds the size of a tool result BEFORE it is appended
 * to the conversation the provider re-sends on every later turn (backlog
 * 3ad735bb / BK1; plan 9ed453c1). One 98 KB `cat SKILL.md` result re-sent each
 * turn cost ~30k tokens per turn on the API path, whereas the `claude` CLI
 * replaces such a result with a ~1.5 KB stub.
 *
 * Semantics (binding architect verdict Q1):
 * - The cap is measured in UTF-16 code units of the serialized text
 *   (`JSON.stringify` for non-string results).
 * - A result at or under the cap is returned untouched (same reference).
 * - Over the cap: `head` = floor(cap * 0.75) chars, `tail` = the rest, joined
 *   by an in-band marker. The marker is added OUTSIDE the cap.
 * - `0` disables the cap. Negative, `NaN`, infinite and non-integer values are
 *   rejected by {@link validateToolResultMaxChars}.
 * - Error results are never truncated while <= {@link ERROR_RESULT_FLOOR_CHARS};
 *   above that they follow the cap, which is floored at that value for errors.
 * - Cut points never split a UTF-16 surrogate pair.
 *
 * Pure: no I/O, no logging. Telemetry intentionally measures the FULL result
 * elsewhere; this module only produces the model-visible form.
 */

/**
 * Default cap: ~1.7k tokens of text. Lowered from 20_000 (~5.7k tokens) by 9ed453c1 CTX: a single
 * uncapped `cat` of an 86 KB file held a 3-turn task at 10.1k tokens of context per turn, whereas 6_000
 * leaves the model the head+tail of the result and a pointer to narrow it (measured in the CTX report).
 */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 6_000;

/** Error results up to this many chars are never truncated. */
export const ERROR_RESULT_FLOOR_CHARS = 4_000;

/** Fraction of the cap spent on the head; the tail gets the remainder. */
const HEAD_FRACTION = 0.75;

/** Config key (Environment cascade) that carries the cap. */
export const TOOL_RESULT_MAX_CHARS_KEY = 'agent.toolResult.maxChars';

/** Env var that carries the cap. */
export const TOOL_RESULT_MAX_CHARS_ENV = 'ADHD_AGENT_TOOL_RESULT_MAX_CHARS';

/** Outcome of {@link capToolResult}. */
export interface ToolResultCapOutcome {
  /** The model-visible result: the input reference when untouched, else a string. */
  readonly result: unknown;
  /** True iff the result was truncated. */
  readonly truncated: boolean;
  /** Serialized length (UTF-16 code units) of the original result. */
  readonly originalChars: number;
}

/**
 * Validates a configured cap. Fails loud (throws) on anything that is not a
 * non-negative safe integer, so a typo cannot silently disable or distort the
 * cap.
 *
 * @param value - the raw configured value
 * @returns the validated cap (`0` = disabled)
 * @throws {RangeError} if `value` is negative, `NaN`, infinite, or not an integer
 */
export function validateToolResultMaxChars(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new RangeError(
      `${TOOL_RESULT_MAX_CHARS_KEY} (${TOOL_RESULT_MAX_CHARS_ENV}) must be a non-negative integer ` +
        `(0 disables the cap); got ${String(value)}`
    );
  }
  return value;
}

/**
 * Strictly parses a cap supplied as text (env var / YAML scalar) or number.
 * Unlike `parseInt`, `"1.5"`, `"20000abc"`, `""` and `"-1"` are rejected
 * rather than silently truncated or coerced to `0` (which would disable the
 * cap).
 *
 * @param raw - the configured value
 * @returns the validated cap (`0` = disabled)
 * @throws {RangeError} on anything that is not a plain non-negative integer
 */
export function parseToolResultMaxChars(raw: unknown): number {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) return validateToolResultMaxChars(Number.NaN);
    return validateToolResultMaxChars(Number(text));
  }
  return validateToolResultMaxChars(raw);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Serializes a tool result the way the model sees it.
 * Returns `undefined` when the value has no JSON form (e.g. `undefined`).
 */
export function serializeToolResult(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

/**
 * Caps a tool result for the model-visible history.
 *
 * @param result - the tool result (string or JSON-serializable value)
 * @param isError - whether the result is an error result
 * @param maxChars - the validated cap; `0` disables
 * @returns the model-visible result plus truncation facts for telemetry
 */
export function capToolResult(
  result: unknown,
  isError: boolean,
  maxChars: number
): ToolResultCapOutcome {
  const text = serializeToolResult(result);
  if (text === undefined) {
    return { result, truncated: false, originalChars: 0 };
  }
  const total = text.length;
  if (maxChars === 0) {
    return { result, truncated: false, originalChars: total };
  }
  const effectiveCap = isError ? Math.max(maxChars, ERROR_RESULT_FLOOR_CHARS) : maxChars;
  if (total <= effectiveCap) {
    return { result, truncated: false, originalChars: total };
  }

  let headLen = Math.floor(effectiveCap * HEAD_FRACTION);
  let tailStart = total - (effectiveCap - headLen);
  // Never end the head on a high surrogate or start the tail on a low one.
  if (headLen > 0 && isHighSurrogate(text.charCodeAt(headLen - 1))) headLen -= 1;
  if (tailStart < total && isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;

  const head = text.slice(0, headLen);
  const tail = text.slice(tailStart);
  const marker =
    `[tool result truncated: showing first ${head.length} and last ${tail.length} of ${total} chars; ` +
    `re-run with a narrower command (e.g. grep, head, sed -n 'a,bp')]`;
  return {
    result: `${head}\n${marker}\n${tail}`,
    truncated: true,
    originalChars: total,
  };
}
