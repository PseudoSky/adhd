import type { Operation } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';

/**
 * The command prefix apigen projects for every operation (`['policy']`): the
 * namespace segment in front of each verb. Lets the bin accept `adhd-policy
 * check` as well as `adhd-policy policy check`.
 */
export function resolveCommandPrefix(operations: readonly Operation[]): string[] {
  const first = operations.find((op) => op.kind === 'action');
  if (first === undefined) {
    throw new Error('@adhd/policy: no action operations were extracted - cannot derive a command prefix');
  }
  return project(first).cli.path.slice(0, -1);
}

/** Prepends `prefix` unless argv is empty, starts with a flag, or is already prefixed. */
export function prefixCommand(argv: readonly string[], prefix: readonly string[]): string[] {
  if (argv.length === 0 || argv[0]?.startsWith('-')) return [...argv];
  if (prefix.length > 0 && prefix.every((segment, index) => argv[index] === segment)) return [...argv];
  return [...prefix, ...argv];
}
