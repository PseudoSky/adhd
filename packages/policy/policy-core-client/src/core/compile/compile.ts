import type {
  ICompileOptions,
  ICompileResult,
  ICompiledPolicy,
  ILayerInput,
  IPolicyIssue,
} from '../../spec';
import { canonicalize } from '../canonical/canonical';
import { deepFreeze } from '../canonical/clone';
import { sha256Hex } from '../canonical/sha256';
import { compileDefaults } from './defaults';
import { checkDeclarations } from './declarations';
import { computeInputHash } from './hash';
import { buildIndex } from './index-builder';
import { orderAndValidate } from './layers';
import { computeNarrowingCoverage } from './narrowing';
import { compilePermissions } from './permissions';

/** The compiler version stamped into every compiled policy; part of `inputHash`. */
export const COMPILER_VERSION = '1';

/**
 * Pure, deterministic, never throws on user input. Steps: `orderAndValidate`
 * -> `compileDefaults` / `compilePermissions` -> `checkDeclarations` ->
 * `computeNarrowingCoverage` -> `buildIndex` -> assemble. `inputHash` hashes
 * the ordered layers + compiler version; `contentHash` hashes the compiled
 * object without `contentHash`. `source` strings are not hashed. `ok: false`
 * iff any error; every issue is reported (D-05), and no partial policy is
 * returned.
 */
export function compile(
  layers: readonly ILayerInput[],
  options?: ICompileOptions
): ICompileResult {
  try {
    const compilerVersion = options?.compilerVersion ?? COMPILER_VERSION;
    const { ordered, documents, issues } = orderAndValidate(layers);
    const defaults = compileDefaults(ordered, documents);
    const permissions = compilePermissions(ordered, documents);
    const declared = checkDeclarations({ ordered, documents, defaults, permissions });
    const errors: IPolicyIssue[] = [...issues, ...declared.errors];
    if (errors.length > 0) return { ok: false, errors, warnings: declared.warnings };

    const body = {
      schemaVersion: 1 as const,
      compilerVersion,
      inputHash: computeInputHash(ordered, compilerVersion),
      attributes: declared.attributes,
      runtime: declared.runtime,
      defaults,
      permissions,
      index: buildIndex(permissions),
      narrowingCovered: computeNarrowingCoverage(permissions),
    };
    const policy: ICompiledPolicy = deepFreeze({
      ...body,
      contentHash: sha256Hex(canonicalize(body)),
    });
    return { ok: true, policy, warnings: declared.warnings };
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: 'schema',
          path: '',
          message: `policy could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
