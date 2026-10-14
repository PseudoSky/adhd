/**
 * R9-pause S2b: the Anthropic `pause_turn` continuation loop, as a pure, SDK-agnostic helper (no I/O of its own,
 * no clock, no import from `anthropic.ts`, so `anthropic.ts` can import it without a cycle).
 *
 * When the API pauses a long server-tool turn it answers `stop_reason: "pause_turn"` with the content produced so
 * far; the documented continuation is to send the request again with that content appended as the final assistant
 * message ("pass the paused response back as-is"). Before this module the provider treated the paused response as a
 * finished turn, so a long `web_fetch` / `web_search` turn was reported `completed` half way.
 *
 * Contract (spec-v2 section 2, "pause_turn (A5)"):
 *  - Every continuation is a real model call. It is counted ({@link IPauseLoopResult.modelCalls} is what the provider
 *    reports as `reportedModelCalls`) and is vetted BEFORE it is sent: the signal is checked, then the engine's
 *    `ProviderChatRequest.beforeContinuation(n)` runs (cancellation, `pre:model_request` budget enforcement, the
 *    `provider:pause_continued` progress event), then the request goes out. A rejection from any of these stops the loop
 *    with no further request.
 *  - The loop is bounded: {@link MAX_PAUSE_TURNS} (5) consecutive `pause_turn` responses fail the call with
 *    {@link PauseTurnCapError} (a `ToolError('PROVIDER_ERROR', ...)`), never a `completed` response holding partial
 *    content. The fifth pause is the cap: at most 5 requests, 4 continuations.
 *  - Spend is never lost: when the loop throws after at least one completed call (cap, abort, a rejected
 *    `beforeContinuation`, a failed continuation) the error carries the usage of the calls already made via
 *    `attachPartialUsage`, so the engine records it on the failed MODEL_RESPONSE.
 *
 * How `anthropic.ts` (S3a) wires it:
 *  - `send` performs ONE API call. Wrap `send`'s body in `callWithRetry`, NOT the whole loop: a transient 529 on
 *    continuation 3 must retry continuation 3, not restart the turn at request 0 and re-pay the earlier calls. Never
 *    wrap {@link runWithPauseTurn} itself in `callWithRetry`: `classifySdkError` classifies the cap/budget/abort errors
 *    `unknown` (not retried) but `callWithRetry` then rewraps them in a `ProviderCallError`, losing their identity and message.
 *  - `send({ n, pausedBlocks })`: `n === 0` is the original request; for `n >= 1` append
 *    `{ role: "assistant", content: pausedBlocks }` after the request's messages, with the same tools and system.
 *    `pausedBlocks` is every block the paused responses produced, in order, untouched.
 *  - `blocks` of the result is the whole turn (all responses concatenated): capture the echo and build the message from
 *    it. `last` is the response that ended the turn (its `stop_reason` and `model`). `usage`, when `usageOf` was passed,
 *    is the sum over all calls.
 *  - `isPauseTurnCapError(err)` lets the engine or provider log the cap distinctly. Let the loop's errors propagate out
 *    of `chat()` unchanged: the engine maps `PauseTurnCapError` (code `PROVIDER_ERROR`) to a failed task.
 */
import { ToolError } from "../validation/errors.js";
import { abortError } from "./provider-failure.js";
import {
  attachPartialUsage,
  mergePartialUsage,
  mergeProviderUsage,
  readPartialUsage,
  type IProviderPartialUsage,
  type ProviderTokenUsage,
} from "./partial-usage.js";

/**
 * Consecutive `pause_turn` responses that fail the call. The 5th pause is the cap, so a turn is allowed at most
 * 4 continuations (5 requests in total).
 */
export const MAX_PAUSE_TURNS = 5;

/** `ToolError.data.kind` of a {@link PauseTurnCapError}: the distinct, machine-readable "capped" outcome. */
export const PAUSE_TURN_CAPPED = "pause_turn_capped";

/** `ToolError.data.kind` of a paused response that carried no content, so there is nothing to continue from. */
export const PAUSE_TURN_EMPTY = "pause_turn_empty";

/** The structural slice of an Anthropic `Message` the loop reads. Any SDK message satisfies it. */
export interface IPauseMessageLike {
  content: readonly unknown[];
  stop_reason?: string | null;
  /** Raw SDK usage; carried into a partial-usage marker as `rawUsage` (the last call's). */
  usage?: unknown;
  model?: string;
}

/** One API call the loop asks the provider to make. */
export interface IPauseCall {
  /** 0 for the original request; 1-based continuation number otherwise. */
  n: number;
  /** Every block the paused responses produced so far, in order. Empty when `n === 0`. Append it as the last assistant message. */
  pausedBlocks: readonly unknown[];
}

export interface IPauseLoopOptions<M extends IPauseMessageLike> {
  /** Performs ONE API call. See the module header for the retry placement. */
  send: (call: IPauseCall) => Promise<M>;
  /**
   * `ProviderChatRequest.beforeContinuation`: awaited with the continuation number before each continuation request
   * is sent. A rejection stops the loop (no request is sent) and propagates.
   */
  beforeContinuation?: (n: number) => Promise<void>;
  /** Checked before every continuation (and before `beforeContinuation`): an aborted signal throws `AbortError`. */
  signal?: AbortSignal;
  /** Consecutive pauses that fail the call. Default {@link MAX_PAUSE_TURNS}. Positive integer. */
  maxPauses?: number;
  /** Observability hook, called after `beforeContinuation` and before the request: the provider logs it. */
  onContinuation?: (info: { n: number; pauses: number }) => void;
  /**
   * Normalises one response's usage (`normaliseAnthropicUsage` in `anthropic.ts`). When given, the result carries the
   * summed usage and every failure after a completed call carries a partial-usage marker.
   */
  usageOf?: (message: M) => ProviderTokenUsage;
}

export interface IPauseLoopResult<M extends IPauseMessageLike> {
  /** Every response, in order; the last one ended the turn. */
  responses: readonly M[];
  /** All blocks of the turn, in order (the responses' contents concatenated). */
  blocks: unknown[];
  /** The response that ended the turn. */
  last: M;
  /** Continuation requests made (`responses.length - 1`). */
  continuations: number;
  /** Real model calls behind the turn (`1 + continuations`): the provider's `reportedModelCalls`. */
  modelCalls: number;
  /** Sum of `usageOf` over all responses (absent when `usageOf` was not given). */
  usage?: ProviderTokenUsage;
}

/**
 * The turn was still paused after {@link MAX_PAUSE_TURNS} (or `maxPauses`) consecutive `pause_turn` responses. A
 * `ToolError('PROVIDER_ERROR', 'provider paused the turn N times without finishing')`: the task fails, it is never
 * reported `completed`. `data` is `{ kind: PAUSE_TURN_CAPPED, pauses, continuations }`.
 */
export class PauseTurnCapError extends ToolError {
  readonly pauses: number;
  readonly continuations: number;

  constructor(pauses: number, continuations: number) {
    super("PROVIDER_ERROR", `provider paused the turn ${pauses} times without finishing`, {
      kind: PAUSE_TURN_CAPPED,
      pauses,
      continuations,
    });
    this.name = "PauseTurnCapError";
    this.pauses = pauses;
    this.continuations = continuations;
  }
}

/**
 * Whether `err` is the cap failure of the pause loop, directly or anywhere in its `cause` chain (a duplicated bundle
 * or a wrapper such as `ProviderCallError` keeps the marker in `data.kind`).
 */
export function isPauseTurnCapError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; typeof e === "object" && e !== null && depth < 5; depth++) {
    if (e instanceof PauseTurnCapError) return true;
    if ((e as { data?: { kind?: unknown } }).data?.kind === PAUSE_TURN_CAPPED) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Sums `usageOf` over `responses` with {@link mergeProviderUsage} (every token class and cache tier; the last call's stop reason). */
export function sumPauseUsage<M extends IPauseMessageLike>(
  responses: readonly M[],
  usageOf: (message: M) => ProviderTokenUsage
): ProviderTokenUsage | undefined {
  let total: ProviderTokenUsage | undefined;
  for (const r of responses) {
    const u = usageOf(r);
    total = total ? mergeProviderUsage(total, u) : u;
  }
  return total;
}

function partialOf<M extends IPauseMessageLike>(
  responses: readonly M[],
  usageOf: (message: M) => ProviderTokenUsage
): IProviderPartialUsage {
  const last = responses[responses.length - 1];
  const usage = sumPauseUsage(responses, usageOf);
  return {
    ...(usage ? { usage } : {}),
    ...(last?.usage !== undefined ? { rawUsage: last.usage } : {}),
    reportedModelCalls: responses.length,
    ...(last?.model ? { responseModel: last.model } : {}),
  };
}

/**
 * Runs `send` until the turn ends, continuing a paused turn up to the cap. See the module header for the contract.
 *
 * @throws {PauseTurnCapError} after `maxPauses` consecutive `pause_turn` responses
 * @throws the `AbortError` of {@link abortError} when the signal aborts between calls
 * @throws whatever `beforeContinuation` or `send` rejects with (partial usage attached when a call had completed)
 */
export async function runWithPauseTurn<M extends IPauseMessageLike>(opts: IPauseLoopOptions<M>): Promise<IPauseLoopResult<M>> {
  const maxPauses = opts.maxPauses ?? MAX_PAUSE_TURNS;
  if (!Number.isInteger(maxPauses) || maxPauses < 1) {
    throw new RangeError(`runWithPauseTurn: maxPauses must be a positive integer (got ${String(maxPauses)})`);
  }
  const responses: M[] = [];
  const blocks: unknown[] = [];
  // True while a request is in flight: its own spend is unknown if it fails, so the carried usage is a lower bound.
  let inFlight = false;
  try {
    for (let pauses = 0; ; ) {
      const n = responses.length;
      if (n > 0) {
        if (opts.signal?.aborted) throw abortError(opts.signal);
        await opts.beforeContinuation?.(n);
        opts.onContinuation?.({ n, pauses });
      }
      inFlight = true;
      const response = await opts.send({ n, pausedBlocks: blocks.slice() });
      inFlight = false;
      responses.push(response);
      blocks.push(...response.content);
      if (response.stop_reason !== "pause_turn") {
        const usage = opts.usageOf ? sumPauseUsage(responses, opts.usageOf) : undefined;
        return {
          responses,
          blocks,
          last: response,
          continuations: n,
          modelCalls: responses.length,
          ...(usage ? { usage } : {}),
        };
      }
      pauses++;
      if (pauses >= maxPauses) throw new PauseTurnCapError(pauses, n);
      if (blocks.length === 0) {
        throw new ToolError("PROVIDER_ERROR", "provider paused the turn without returning any content to continue from", {
          kind: PAUSE_TURN_EMPTY,
          pauses,
          continuations: n,
        });
      }
    }
  } catch (err) {
    if (opts.usageOf && responses.length > 0) {
      const spent = partialOf(responses, opts.usageOf);
      const earlier = readPartialUsage(err);
      // A failed in-flight call spent something we cannot see: fold an empty marker so the sum is flagged a lower bound.
      const withUnknown = inFlight ? mergePartialUsage(spent, {}) : spent;
      attachPartialUsage(err, earlier ? mergePartialUsage(withUnknown, earlier) : withUnknown);
    }
    throw err;
  }
}
