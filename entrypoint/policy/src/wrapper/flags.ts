import { ApiError } from '@adhd/apigen-base-errors';

/** The result of {@link splitPolicyArgv}. */
export interface ISplitArgv {
  /** Non-flag tokens before the first `--` (the source). */
  readonly positionals: readonly string[];
  /** `--spec <file>` values in order (repeatable). */
  readonly specFiles: readonly string[];
  /** The `--adhd-attributes` value (JSON, or `@file`), if given. */
  readonly attributes?: string;
  /** The `--name` value (the `serve` operation-id prefix), if given. */
  readonly name?: string;
  /** Everything after the first `--`, untouched. */
  readonly childArgs: readonly string[];
}

const OWN_VALUE_FLAGS: ReadonlySet<string> = new Set(['--spec', '--adhd-attributes', '--name']);

/**
 * Splits argv at the first literal `--`. Before it, extracts adhd-policy's own
 * flags (`--spec <f>`, repeatable; `--adhd-attributes <v>`; `--name <alias>`)
 * in both `--flag v` and `--flag=v` forms; any other flag is
 * `ApiError('invalid_argument', 'unknown flag ...')`. A flag value that starts
 * with `--` is refused (a forgotten value must not swallow the next flag), and
 * a single-valued flag given twice is `invalid_argument` rather than silently
 * last-wins. Everything after `--` is returned untouched as `childArgs`, so the
 * child never sees `--adhd-*` (PS-28 / VR-09).
 */
export function splitPolicyArgv(argv: readonly string[]): ISplitArgv {
  const dashDash = argv.indexOf('--');
  const head = dashDash < 0 ? argv : argv.slice(0, dashDash);
  const childArgs = dashDash < 0 ? [] : argv.slice(dashDash + 1);
  const positionals: string[] = [];
  const specFiles: string[] = [];
  let attributes: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index] as string;
    if (!token.startsWith('--') || token === '--') {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (!OWN_VALUE_FLAGS.has(flag)) {
      throw new ApiError('invalid_argument', `unknown flag ${flag}`);
    }
    let value: string | undefined;
    if (equals >= 0) {
      value = token.slice(equals + 1);
    } else {
      value = head[index + 1];
      index += 1;
    }
    if (value === undefined || value.length === 0) {
      throw new ApiError('invalid_argument', `${flag} needs a value`);
    }
    if (value.startsWith('--')) {
      throw new ApiError('invalid_argument', `${flag} needs a value, got "${value}" (a value may not start with --)`);
    }
    if (flag === '--spec') {
      specFiles.push(value);
    } else if (flag === '--adhd-attributes') {
      if (attributes !== undefined) throw new ApiError('invalid_argument', '--adhd-attributes was given more than once');
      attributes = value;
    } else {
      if (name !== undefined) throw new ApiError('invalid_argument', '--name was given more than once');
      name = value;
    }
  }
  return {
    positionals,
    specFiles,
    ...(attributes !== undefined ? { attributes } : {}),
    ...(name !== undefined ? { name } : {}),
    childArgs,
  };
}
