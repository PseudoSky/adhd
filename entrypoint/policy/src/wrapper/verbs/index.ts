import type { IVerbDeps } from './deps';
import { reportFailure } from './failure';

/** The wrapper verbs that run before apigen's own command table. */
export const VERB_NAMES = ['run', 'serve', 'mcp-json', 'migrate'] as const;

/**
 * Returns `{handled:false}` when `argv[0]` is not a verb, else runs it (argv
 * without the verb name) and returns `{handled:true, exitCode}`. Each verb is
 * loaded on demand, so a plain `check` never loads the gateway, the policy
 * Layer or the MCP SDK.
 */
export async function dispatchVerb(
  argv: readonly string[],
  deps: IVerbDeps & { signal?: AbortSignal }
): Promise<{ handled: boolean; exitCode?: number }> {
  const verb = argv[0];
  const rest = argv.slice(1);
  try {
    switch (verb) {
      case 'run':
        return { handled: true, exitCode: await (await import('./run')).runVerb(rest, deps) };
      case 'serve':
        return {
          handled: true,
          exitCode: await (await import('./serve')).serveVerb(rest, { ...deps, signal: deps.signal ?? new AbortController().signal }),
        };
      case 'mcp-json':
        return { handled: true, exitCode: await (await import('./mcp-json')).mcpJsonVerb(rest, deps) };
      case 'migrate':
        return { handled: true, exitCode: await (await import('./migrate')).migrateVerb(rest, deps) };
      default:
        return { handled: false };
    }
  } catch (error) {
    return { handled: true, exitCode: reportFailure(error, deps) };
  }
}
