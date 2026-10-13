import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ApiError } from '@adhd/apigen-base-errors';
import { policyDistDir, writeBakedIr } from './ir';
import { reportFailure } from './verbs/failure';

/**
 * The hidden build-time subcommand `ir-artifact --out <file>` (argv excludes
 * the subcommand name): bakes the operation surface to `<file>`, which must
 * resolve under this package's `dist/` so a stray `--out` can never overwrite
 * an arbitrary file. Returns the exit code; any failure (`ApiError` mapped
 * through `CLI_EXIT_CODE`, anything else 1) prints its message alone to stderr,
 * never a stack trace.
 */
export async function runIrArtifact(
  argv: readonly string[],
  deps: { cwd: string; stderr: (text: string) => void }
): Promise<number> {
  try {
    const flag = argv.indexOf('--out');
    const out = flag < 0 ? undefined : argv[flag + 1];
    if (out === undefined || out.length === 0 || out.startsWith('--')) {
      throw new ApiError('invalid_argument', 'ir-artifact requires --out <file>');
    }
    const target = resolve(deps.cwd, out);
    const fromDist = relative(policyDistDir(), target);
    if (fromDist === '' || fromDist === '..' || fromDist.startsWith(`..${sep}`) || isAbsolute(fromDist)) {
      throw new ApiError('invalid_argument', `ir-artifact --out must be a file under ${policyDistDir()}, got ${target}`);
    }
    await writeBakedIr(target);
    return 0;
  } catch (error) {
    return reportFailure(error, deps);
  }
}
