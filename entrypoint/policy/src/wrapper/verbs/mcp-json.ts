import { resolve } from 'node:path';
import { ApiError } from '@adhd/apigen-base-errors';
import { initMcpJson } from '../mcp-json/init';
import { undoMcpJson } from '../mcp-json/undo';
import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

interface IMcpJsonArgs {
  readonly undo: boolean;
  readonly file?: string;
  readonly spec?: string;
  readonly only: readonly string[];
}

function parseMcpJsonArgs(argv: readonly string[]): IMcpJsonArgs {
  let undo = false;
  let file: string | undefined;
  let spec: string | undefined;
  const only: string[] = [];
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ApiError('invalid_argument', `${flag} needs a value`);
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
      case '--file':
      case '--spec':
      case '--only': {
        const value = inline ?? valueOf(name, index);
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
  return { undo, ...(file !== undefined ? { file } : {}), ...(spec !== undefined ? { spec } : {}), only };
}

/**
 * `mcp-json init [--file <p>] --spec <f> [--only <name>]...` wraps stdio
 * entries of a `.mcp.json` so the host launches `adhd-policy serve bin:<cmd>`;
 * `mcp-json --undo [--file <p>]` (also accepted as `init --undo`) restores the
 * original byte for byte. `--file` defaults to `.mcp.json` in the working
 * directory; the spec path is written absolute. argv excludes the verb name.
 * Nothing is started. Prints a JSON summary to stdout; returns 0, or the
 * failure's exit code (a missing backup is 4).
 */
export async function mcpJsonVerb(argv: readonly string[], deps: IVerbDeps): Promise<number> {
  try {
    const args = parseMcpJsonArgs(argv);
    const file = resolve(deps.cwd, args.file ?? '.mcp.json');
    if (args.undo) {
      deps.stdout(`${JSON.stringify(await undoMcpJson({ file }))}\n`);
      return 0;
    }
    if (args.spec === undefined) {
      throw new ApiError('invalid_argument', 'usage: adhd-policy mcp-json init --spec <file> [--file <.mcp.json>] [--only <name>]... | adhd-policy mcp-json --undo [--file <.mcp.json>]');
    }
    const result = await initMcpJson({ file, specFile: resolve(deps.cwd, args.spec), only: args.only });
    deps.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    return reportFailure(error, deps);
  }
}
