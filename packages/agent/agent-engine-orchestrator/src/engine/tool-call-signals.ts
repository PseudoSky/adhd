/**
 * `tool-call-signals.ts` — pure derivation of the R10 per-call trace signals the engine puts on
 * `post:tool_call` (`errorClass`, `resultBytes`). Pure and content-free: nothing here keeps or
 * returns any part of a tool's arguments or output, only a class and a byte count.
 */
import type { ToolCallErrorClass } from '@adhd/agent-base-types';

/**
 * The shell server's own refusal of a command its default policy never allows (`node`, `sed`,
 * `sh`, ...). It reaches the engine as the text of a thrown MCP error, so the class is read from
 * the message. A refusal is an expected outcome, not a fault.
 */
export const SHELL_POLICY_REJECTION = /Command rejected by default security policy/;

/** What the engine knows about a finished call. */
export interface IToolCallOutcome {
  /** The call failed (a thrown tool error, a schema mismatch, or an unreachable server). */
  isError: boolean;
  /** The failure was an allowlist / policy DENIAL (`isDenial` on `post:tool_call`). */
  isDenial: boolean;
  /** The arguments did not match the tool's declared schema and the engine refused them. */
  argMismatch: boolean;
  /** The engine repaired at least one argument (a stringified array/object) before the call. */
  argCoerced: boolean;
  /** The shell trailer's exit status, when the call succeeded with a non-zero exit. */
  exitStatus?: number;
  /** The error text (only consulted when `isError`). */
  errorText?: string;
}

/**
 * Coarse outcome of one tool call, for attribution. Precedence, first match wins:
 * `policy_rejected` > `arg_mismatch` > `tool_error` > `exit_nonzero` > `arg_coerced` > `none`.
 * A call whose arguments were coerced and then failed is a `tool_error`; `arg_coerced` is reported
 * only for a call that went on to succeed.
 */
export function classifyToolCallOutcome(o: IToolCallOutcome): ToolCallErrorClass {
  if (o.isDenial || (o.isError && o.errorText !== undefined && SHELL_POLICY_REJECTION.test(o.errorText))) {
    return 'policy_rejected';
  }
  if (o.argMismatch) return 'arg_mismatch';
  if (o.isError) return 'tool_error';
  if (o.exitStatus !== undefined && o.exitStatus !== 0) return 'exit_nonzero';
  if (o.argCoerced) return 'arg_coerced';
  return 'none';
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * UTF-8 byte length of what the model is shown for a tool result: the text itself, not its JSON
 * encoding. A string counts as is; an MCP content array counts the `text` of its text blocks
 * (any other block counts as its JSON); any other value counts as its JSON. `undefined` is 0.
 *
 * Measured on the result AFTER the size cap / spill and BEFORE the `transform:tool_result` hooks
 * and the provider's wire encoding, so it is independent of both.
 */
export function modelVisibleBytes(result: unknown): number {
  if (result === undefined) return 0;
  if (typeof result === 'string') return utf8Bytes(result);
  if (Array.isArray(result)) {
    let total = 0;
    for (const block of result) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        total += utf8Bytes((block as { text: string }).text);
      } else {
        total += utf8Bytes(JSON.stringify(block) ?? '');
      }
    }
    return total;
  }
  return utf8Bytes(JSON.stringify(result) ?? '');
}
