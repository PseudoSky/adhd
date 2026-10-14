import { createAttributesSource, type IAttributesSource } from './attributes-source';
import type { ISplitArgv } from './flags';
import type { IVerbDeps } from './verbs/deps';

/** The environment variable that names who is asking when no `--adhd-attributes` flag is given (D-06). */
export const ATTRIBUTES_ENV_VAR = 'ADHD_POLICY_ATTRIBUTES';

/**
 * Builds the attribute source for a verb from its parsed flags and the verb's
 * environment (D-06: the flag, else `ADHD_POLICY_ATTRIBUTES`, else none), then
 * reads it once so a bad value refuses to start before anything is launched.
 * Shared by `run` and `serve`.
 */
export async function attributesFromFlags(
  split: Pick<ISplitArgv, 'attributes'>,
  deps: Pick<IVerbDeps, 'cwd' | 'env' | 'readFile'>
): Promise<IAttributesSource> {
  const source = createAttributesSource({
    ...(split.attributes !== undefined ? { flag: split.attributes } : {}),
    ...(deps.env[ATTRIBUTES_ENV_VAR] !== undefined ? { env: deps.env[ATTRIBUTES_ENV_VAR] as string } : {}),
    cwd: deps.cwd,
    ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
  });
  await source.read();
  return source;
}
