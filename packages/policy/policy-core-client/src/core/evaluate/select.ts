import type { ICompiledPermission, ICompiledPolicy } from '../../spec';
import { selectIndexes } from '../compile/index-builder';

/** Permissions whose `tool` matches, in evaluation order (layer order, then file order). */
export function selectPermissions(
  policy: ICompiledPolicy,
  tool: string
): readonly ICompiledPermission[] {
  return selectIndexes(policy.index, tool).map((i) => policy.permissions[i]);
}
