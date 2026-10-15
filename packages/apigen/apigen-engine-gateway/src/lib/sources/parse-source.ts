import { ApiError } from '@adhd/apigen-base-errors';
import type { SourceSpec } from './types';

/**
 * Parse a source argument. `'bin:<command>'` -> bin; `'remote:<url>'` -> remote
 * (http/https only, else `invalid_argument`); anything else -> file. The command must
 * be non-empty and contain no whitespace (a name or path, never a command line;
 * arguments are passed separately and never through a shell) else
 * `ApiError('invalid_argument')`. Pure: nothing is executed or touched.
 *
 * Back-compat for callers that still hold a {@link SourceSpec}; new callers classify a
 * reference with the core `resolveSourceReference(reference, nodeSourceProbe)` and pass the
 * resolution to `resolveSource`.
 */
export function parseSourceSpec(text: string): SourceSpec {
  if (text.startsWith('bin:')) {
    const command = text.slice('bin:'.length);
    if (command.length === 0) {
      throw new ApiError('invalid_argument', 'bin: source needs a command name or path');
    }
    if (/\s/.test(command)) {
      throw new ApiError(
        'invalid_argument',
        'bin: source must be a command name or path with no arguments or whitespace; pass arguments separately'
      );
    }
    return { kind: 'bin', command };
  }
  if (text.startsWith('remote:')) {
    const url = text.slice('remote:'.length);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError('invalid_argument', `remote: source is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError('invalid_argument', `remote: source must be http or https, got ${parsed.protocol}`);
    }
    return { kind: 'remote', url };
  }
  if (text.length === 0) {
    throw new ApiError('invalid_argument', 'empty source');
  }
  return { kind: 'file', path: text };
}
