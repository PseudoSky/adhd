import type { IVerbDeps } from './deps';

/** The wrapper verbs that run before apigen's own command table. */
export const VERB_NAMES = ['run', 'serve', 'mcp-json'] as const;

/**
 * Returns `{handled:false}` when `argv[0]` is not a verb, else runs it and
 * returns `{handled:true, exitCode}`.
 */
export async function dispatchVerb(
  argv: readonly string[],
  deps: IVerbDeps & { signal?: AbortSignal }
): Promise<{ handled: boolean; exitCode?: number }> {
  void argv;
  void deps;
  return { handled: false };
}
