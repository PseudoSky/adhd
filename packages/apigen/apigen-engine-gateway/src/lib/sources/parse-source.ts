import { SourceError } from './types';
import type { SourceSpec } from './types';

/**
 * Parse a source argument. `'bin:<command>'` -> bin; `'remote:<url>'` -> remote
 * (http/https only, else `invalid-spec`); anything else -> file. The command must
 * be non-empty and contain no whitespace (a name or path, never a command line;
 * arguments are passed separately and never through a shell) else
 * `SourceError('invalid-spec')`. Pure: nothing is executed or touched.
 */
export function parseSourceSpec(text: string): SourceSpec {
  if (text.startsWith('bin:')) {
    const command = text.slice('bin:'.length);
    if (command.length === 0) {
      throw new SourceError('invalid-spec', 'bin: source needs a command name or path');
    }
    if (/\s/.test(command)) {
      throw new SourceError(
        'invalid-spec',
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
      throw new SourceError('invalid-spec', `remote: source is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SourceError('invalid-spec', `remote: source must be http or https, got ${parsed.protocol}`);
    }
    return { kind: 'remote', url };
  }
  if (text.length === 0) {
    throw new SourceError('invalid-spec', 'empty source');
  }
  return { kind: 'file', path: text };
}
