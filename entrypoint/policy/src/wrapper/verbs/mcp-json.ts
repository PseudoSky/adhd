import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { ApiError } from '@adhd/apigen-base-errors';
import { initMcpJson } from '../mcp-json/init';
import { undoMcpJson } from '../mcp-json/undo';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

interface IMcpJsonArgs {
  readonly undo: boolean;
  readonly force: boolean;
  readonly replace: boolean;
  readonly file?: string;
  readonly spec?: string;
  readonly only: readonly string[];
}

function parseMcpJsonArgs(argv: readonly string[]): IMcpJsonArgs {
  let undo = false;
  let force = false;
  let replace = false;
  let file: string | undefined;
  let spec: string | undefined;
  const only: string[] = [];
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) throw new ApiError('invalid_argument', `${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const [name, inline] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    switch (name) {
      case 'init':
        break;
      case '--undo':
        undo = true;
        break;
      case '--force':
        force = true;
        break;
      case '--replace':
        replace = true;
        break;
      case '--file':
      case '--spec':
      case '--only': {
        const value = inline ?? valueOf(name, index);
        if (value.startsWith('--')) throw new ApiError('invalid_argument', `${name} needs a value, got "${value}" (a value may not start with --)`);
        if (inline === undefined) index += 1;
        if (name === '--file') file = value;
        else if (name === '--spec') spec = value;
        else only.push(value);
        break;
      }
      default:
        throw new ApiError('invalid_argument', `unknown argument ${token}`);
    }
  }
  if (force && !undo) throw new ApiError('invalid_argument', '--force applies to --undo only');
  if (replace && undo) throw new ApiError('invalid_argument', '--replace applies to init only');
  return { undo, force, replace, ...(file !== undefined ? { file } : {}), ...(spec !== undefined ? { spec } : {}), only };
}

/**
 * The spec path written into a wrapped entry. An absolute `--spec` is stored as
 * given; a relative one is stored relative to the directory of the `.mcp.json`
 * (where a host launches the entry from), so a project that moves keeps working.
 */
function specForEntry(spec: string, cwd: string, file: string): string {
  if (isAbsolute(spec)) return spec;
  return relative(dirname(file), resolve(cwd, spec));
}

/**
 * `mcp-json init [--file <p>] --spec <f> [--only <name>]... [--replace]` wraps
 * stdio entries of a `.mcp.json` so the host launches `adhd-policy serve
 * bin:<cmd>`; `mcp-json --undo [--file <p>] [--force]` (also accepted as
 * `init --undo`) restores the original byte for byte, but only while the file is
 * still what `init` wrote (`--force` restores anyway). `--file` defaults to
 * `.mcp.json` in the working directory; a relative `--spec` is written relative
 * to the file's directory, an absolute one as given. Nothing is started. Prints
 * a JSON summary to stdout (an entry already wrapped under another spec is
 * listed with that spec and noted on stderr unless `--replace` rewrites it);
 * returns 0, or the failure's exit code (a missing backup or file is 4, an
 * unknown `--only` name or a modified file on `--undo` is 2).
 */
export async function mcpJsonVerb(argv: readonly string[], deps: IVerbDeps): Promise<number> {
  try {
    const args = parseMcpJsonArgs(argv);
    const file = resolve(deps.cwd, args.file ?? '.mcp.json');
    if (args.undo) {
      deps.stdout(`${JSON.stringify(await undoMcpJson({ file, force: args.force }))}\n`);
      return 0;
    }
    if (args.spec === undefined) {
      throw new ApiError('invalid_argument', 'usage: adhd-policy mcp-json init --spec <file> [--file <.mcp.json>] [--only <name>]... [--replace] | adhd-policy mcp-json --undo [--file <.mcp.json>] [--force]');
    }
    const result = await initMcpJson({
      file,
      specFile: specForEntry(args.spec, deps.cwd, file),
      only: args.only,
      replace: args.replace,
    });
    for (const skip of result.skipped) {
      if (skip.reason === 'already-wrapped' && skip.spec !== undefined) {
        deps.stderr(`${skip.name}: already wrapped under --spec ${skip.spec.join(', ') || '(none)'}; pass --replace to rewrite it\n`);
      }
    }
    deps.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    return reportFailure(error, deps);
  }
}
