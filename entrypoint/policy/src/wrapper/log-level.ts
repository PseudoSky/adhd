import { ApiError } from '@adhd/apigen-base-errors';

/** The `logging.level` setting of the policy environment spec; its environment variable. */
export const LOG_LEVEL_ENV_VAR = 'ADHD_POLICY_LOG_LEVEL';

const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

/** A level the apigen logger accepts. */
export type PolicyLogLevel = (typeof LEVELS)[number];

/**
 * The apigen CLI logger level. apigen logs a `-> <command>` line at `info` on
 * every dispatch; a command line must print only its result, so the default is
 * `warn`. `ADHD_POLICY_LOG_LEVEL` (the environment spec's `logging.level`)
 * raises it; an unknown value is `ApiError('invalid_argument')`.
 */
export function resolveLogLevel(raw: string | undefined): PolicyLogLevel {
  if (raw === undefined || raw === '') return 'warn';
  if (!(LEVELS as readonly string[]).includes(raw)) {
    throw new ApiError('invalid_argument', `${LOG_LEVEL_ENV_VAR} must be one of ${LEVELS.join(', ')}, got "${raw}"`);
  }
  return raw as PolicyLogLevel;
}
