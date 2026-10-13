/**
 * Path helper for the shared ADHD data root. Pure: the environment is a
 * parameter, never read from the process.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `<ADHD_HOME>/<segments...>`, where ADHD_HOME comes from `env` and falls
 * back to `<home>/.adhd`. `home` defaults to the OS home directory; pass
 * it explicitly to stay fully pure.
 *
 * @example adhdDataDir(['reverse', 'data'], { ADHD_HOME: '/x' })
 * // '/x/reverse/data'
 */
export function adhdDataDir(
  segments: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  home?: string,
): string {
  const fromEnv = env['ADHD_HOME'];
  const root =
    fromEnv !== undefined && fromEnv.trim() !== '' ?
      fromEnv :
      join(home ?? homedir(), '.adhd');
  return join(root, ...segments);
}
