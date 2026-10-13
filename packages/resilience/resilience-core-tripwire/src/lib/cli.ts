/**
 * `runUnlockCli`: the body of an unlock bin, with injected IO.
 *
 * A consumer's bin is five lines: build its tripwire, then
 * `process.exitCode = await runUnlockCli(process.argv.slice(2),
 * nodeTripwireIo(), tw)`. Output strings and exit codes are those of the
 * reverse-apis `unlock-tripwire` tool:
 *
 * - 0: unlocked, or no lock present (nothing to do);
 * - 1: usage error, invalid key, missing or mismatched confirmation;
 * - 2: unexpected IO error.
 *
 * Confirmation: `CONFIRM` in the environment (scripted, audited as
 * `unlock-cli-env`) or the TTY prompt (audited as `unlock-cli-tty`). With
 * neither, the lock is kept and the exit code is 1.
 */
import { isTripwireError } from './errors.js';
import type { TripwireIo } from './io.js';
import {
  CONFIRM_TOKEN,
  type ClearMethod,
  type JsonValue,
  type Tripwire,
  type TripwireSnapshot,
} from './types.js';

/** Exit code of {@link runUnlockCli}. */
export type UnlockExitCode = 0 | 1 | 2;

/** Options of {@link runUnlockCli}. */
export interface UnlockCliOptions {
  /** Usage line printed when no key is given. */
  usage?: string;
  /**
   * Where the lock of `key` lives, shown in the messages (the tripwire
   * does not expose paths). Absent: messages name the key only.
   */
  lockPath?: (key: string) => string;
  /** Actor recorded on the cleared audit event. */
  actor?: string;
}

/** The usage line of the reverse-apis bin. */
export const DEFAULT_UNLOCK_USAGE = 'Usage: pnpm unlock-tripwire <client>';

function shown(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return '(none)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run the unlock flow for `argv[0]` (argv WITHOUT the node and script
 * paths, i.e. `process.argv.slice(2)`). Returns the exit code; never
 * calls `process.exit` and never throws.
 */
export async function runUnlockCli(
  argv: readonly string[],
  io: TripwireIo,
  tw: Tripwire,
  opts: UnlockCliOptions = {},
): Promise<UnlockExitCode> {
  const key = argv[0];
  if (key === undefined || key === '') {
    io.err(opts.usage ?? DEFAULT_UNLOCK_USAGE);
    return 1;
  }
  const where = opts.lockPath?.(key);

  let snap: TripwireSnapshot;
  try {
    snap = await tw.read(key);
  } catch (e) {
    if (isTripwireError(e) && e.code === 'TRIPWIRE_INVALID_KEY') {
      io.err(`invalid tripwire key: ${message(e)}`);
      return 1;
    }
    io.err(`failed to read tripwire: ${message(e)}`);
    return 2;
  }
  if (snap.status === 'clear' || snap.record === null) {
    io.out(`no tripwire to unlock for ${key}`);
    return 0;
  }

  const record = snap.record;
  const unreadable = snap.status === 'unreadable';
  if (unreadable) {
    const detail = shown(record.context['error']);
    io.err(
      where === undefined ?
        `warning: lock for ${key} could not be parsed as JSON: ${detail}` :
        `warning: lock at ${where} could not be parsed as JSON: ${detail}`,
    );
  }
  const field = (v: JsonValue | undefined): string =>
    unreadable ? '(none)' : shown(v);
  io.err(
    where === undefined ?
      `Tripwire lock for "${key}":` :
      `Tripwire lock for "${key}" at ${where}:`,
  );
  io.err(`  reason:          ${field(record.reason)}`);
  io.err(`  trippedAt:       ${field(record.trippedAt)}`);
  io.err(`  lastStatus:      ${field(record.context['lastStatus'])}`);
  io.err(`  lastOperationId: ${field(record.context['lastOperationId'])}`);

  let confirm: string;
  let method: ClearMethod;
  const fromEnv = io.env['CONFIRM'];
  if (fromEnv !== undefined) {
    confirm = fromEnv;
    method = 'unlock-cli-env';
  } else {
    if (!io.isTTY) {
      io.err(
        '\nNo TTY detected and CONFIRM env var is unset. ' +
          `Re-run interactively or set CONFIRM=${CONFIRM_TOKEN}.`,
      );
      return 1;
    }
    const answer = await io.question(`Type '${CONFIRM_TOKEN}' to confirm: `);
    if (answer === null) {
      io.err('\nNo confirmation received (input closed). Lock NOT removed.');
      return 1;
    }
    confirm = answer.trim();
    method = 'unlock-cli-tty';
  }

  if (confirm !== CONFIRM_TOKEN) {
    io.err('\nConfirmation mismatch. Lock NOT removed.');
    return 1;
  }

  try {
    const clearOpts: Parameters<Tripwire['clear']>[1] = { method, confirm };
    if (opts.actor !== undefined) clearOpts.actor = opts.actor;
    const r = await tw.clear(key, clearOpts);
    if (!r.cleared) {
      io.out(`no tripwire to unlock for ${key}`);
      return 0;
    }
    io.out(
      where === undefined ?
        `unlocked tripwire for ${key}` :
        `unlocked tripwire for ${key} (removed ${where})`,
    );
    return 0;
  } catch (e) {
    io.err(`failed to unlock: ${message(e)}`);
    return 2;
  }
}
