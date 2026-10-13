/**
 * Human-in-the-loop gates over a tripwire, with injected IO.
 *
 * - `interactiveGate`: the pre-work gate loop. While the key is tripped it
 *   counts one block, prints the banner and asks `[retry/clear/abort]`.
 * - `confirmSolved`: the post-trip prompt shown after a challenge fired
 *   ("solve it in the browser, then press ENTER").
 *
 * Both fail closed: without a TTY, or when the input reaches EOF, they
 * throw {@link TripwireAbortedError} and the lock stays in place (the
 * legacy loop waited forever on a closed stdin).
 *
 * Clear policy: both clear through `tw.clear`, so on a `confirm-token`
 * instance the clear throws `TripwireConfirmError` unless the caller
 * passes `confirm` explicitly in the options. A TTY alone is never treated
 * as the confirm token.
 */
import { TripwireAbortedError } from './errors.js';
import type { TripwireIo } from './io.js';
import type {
  ClearOptions,
  TripContext,
  Tripwire,
  TripwireRecord,
} from './types.js';

/** Forensic details shown by {@link confirmSolved}. */
export interface HitlInfo {
  /** Why the work stopped, e.g. `captcha`. */
  reason: string;
  /** The query or request that hit the block. */
  query?: string;
  /** The strategy in use when it fired. */
  strategy?: string;
  /** The page the human should look at. */
  pageUrl?: string;
  /** Correlation id of the invocation. */
  sessionId?: string;
}

/** Options shared by the interactive gates. */
export interface InteractiveOptions {
  /** Label of the key line in the banner; default `Key`. */
  keyLabel?: string;
  /**
   * Confirm token forwarded to `tw.clear`. Needed only when the instance
   * uses the `confirm-token` policy; the caller opts in explicitly.
   */
  confirm?: string;
  /** Actor recorded on the cleared audit event. */
  actor?: string;
}

/** Options of {@link interactiveGate}. */
export type InteractiveGateOptions = InteractiveOptions;

/** Options of {@link confirmSolved}. */
export type ConfirmSolvedOptions = InteractiveOptions;

const RULE = '══════════════════════════════════════════════════';

/** `label:` padded so values line up at a fixed column. */
function row(label: string, value: string, width: number): string {
  return `  ${`${label}:`.padEnd(width)}${value}`;
}

function clearOpts(
  method: ClearOptions['method'],
  reverified: boolean,
  o: InteractiveOptions,
): ClearOptions {
  const c: ClearOptions = { method, reverified };
  if (o.confirm !== undefined) c.confirm = o.confirm;
  if (o.actor !== undefined) c.actor = o.actor;
  return c;
}

/** The banner lines of the gate loop for one tripped record. */
export function gateBanner(
  key: string,
  record: TripwireRecord | null,
  keyLabel = 'Key',
): string[] {
  const page = record?.context['pageUrl'];
  const lines = [
    '',
    RULE,
    '  ⛔  TRIPWIRE TRIPPED',
    RULE,
    row(keyLabel, key, 13),
    row('Reason', record?.reason ?? 'unknown', 13),
    row('Tripped at', record?.trippedAt ?? '?', 13),
    row('Blocked by', `${record?.blockedCount ?? 0} gate(s)`, 13),
  ];
  if (typeof page === 'string' && page !== '') {
    lines.push(row('Page', page, 13));
  }
  lines.push(
    '',
    '  A previous run hit a block. Solve the challenge',
    '  in your browser, then clear this lock to continue.',
    '  (Or type "abort" to stop here,',
    '   or "clear" to force-clear without retrying.)',
    RULE,
    '',
  );
  return lines;
}

/** The banner lines of the post-trip prompt. */
export function hitlBanner(
  key: string,
  info: HitlInfo,
  keyLabel = 'Key',
): string[] {
  return [
    '',
    RULE,
    '  🛑  HUMAN-IN-THE-LOOP INTERRUPT',
    RULE,
    row(keyLabel, key, 14),
    row('Query', info.query ?? '(none)', 14),
    row('Reason', info.reason, 14),
    row('Strategy', info.strategy ?? '(none)', 14),
    row('Page', info.pageUrl ?? '(none)', 14),
    row('Session', info.sessionId ?? '(none)', 14),
    '',
    '  The browser is open on this page.',
    '  Solve the challenge, then press ENTER to continue.',
    '  (Or type "abort" to give up.)',
    RULE,
    '',
  ];
}

/**
 * Gate `key` interactively. Each iteration gates once (one counted block
 * while tripped), prints the banner and asks `[retry/clear/abort]`:
 * - `abort` throws {@link TripwireAbortedError}; the lock is kept;
 * - `clear` clears with method `hitl-clear`;
 * - `retry`, Enter or any other input clears with method `hitl-retry` and
 *   `reverified: true` (unknown input still means retry, as before).
 * After a clear the key is gated again, so a trip that raced in is shown
 * again; the function returns once the gate is open. A non-TTY io, or a
 * `question` that resolves `null` (EOF), aborts with the lock kept.
 */
export async function interactiveGate<C extends TripContext>(
  tw: Tripwire<C>,
  key: string,
  io: TripwireIo,
  opts: InteractiveGateOptions = {},
): Promise<void> {
  for (;;) {
    const g = await tw.gate(key);
    if (g.open) return;
    for (const line of gateBanner(key, g.snapshot.record, opts.keyLabel)) {
      io.err(line);
    }
    if (!io.isTTY) {
      io.err(`  No TTY: cannot prompt. Tripwire "${key}" stays tripped.`);
      throw new TripwireAbortedError(
        `Tripwire gate blocked ${key} (no TTY)`,
        key,
      );
    }
    const answer = await io.question('  [retry/clear/abort] > ');
    if (answer === null) {
      io.err(`  Input closed. Tripwire "${key}" stays tripped.`);
      throw new TripwireAbortedError(
        `Tripwire gate blocked ${key} (input closed)`,
        key,
      );
    }
    const cmd = answer.toLowerCase().trim();
    if (cmd === 'abort') {
      throw new TripwireAbortedError(
        `Tripwire gate blocked ${key} (user abort)`,
        key,
      );
    }
    if (cmd === 'clear') {
      await tw.clear(key, clearOpts('hitl-clear', false, opts));
      io.err('  Tripwire cleared. Starting fresh.');
      continue;
    }
    await tw.clear(key, clearOpts('hitl-retry', true, opts));
    io.err('  Tripwire acknowledged. Retrying.');
  }
}

/**
 * After a trip fired: show the banner and wait for the human. Enter (or
 * any input other than `abort`) clears `key` with method `hitl-retry` and
 * `reverified: true`. `abort`, a non-TTY io or EOF throw
 * `TripwireAbortedError('HITL aborted by user')` and the lock stays for
 * the next invocation.
 */
export async function confirmSolved<C extends TripContext>(
  tw: Tripwire<C>,
  key: string,
  info: HitlInfo,
  io: TripwireIo,
  opts: ConfirmSolvedOptions = {},
): Promise<void> {
  for (const line of hitlBanner(key, info, opts.keyLabel)) io.err(line);
  if (!io.isTTY) {
    io.err(`  No TTY: cannot prompt. Tripwire "${key}" stays tripped.`);
    throw new TripwireAbortedError('HITL aborted by user', key);
  }
  const answer = await io.question('  Press ENTER to retry (or "abort") > ');
  if (answer === null || answer.toLowerCase().trim() === 'abort') {
    throw new TripwireAbortedError('HITL aborted by user', key);
  }
  await tw.clear(key, clearOpts('hitl-retry', true, opts));
}
