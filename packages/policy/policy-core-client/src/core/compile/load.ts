import type { ICompiledPolicy } from '../../spec';
import { COMPILED_SCHEMA } from '../../spec';
import { canonicalize } from '../canonical/canonical';
import { deepClone, deepFreeze } from '../canonical/clone';
import { sha256Hex } from '../canonical/sha256';
import { PolicyLoadError } from '../errors';
import { validateSchema } from '../schema/validate';

/**
 * Loads a stored compiled policy (CL-13). Validates against `COMPILED_SCHEMA`
 * (code `malformed`), requires `schemaVersion === 1` (`schema-version`) and
 * recomputes `contentHash` (`hash-mismatch`). Returns a deep-frozen copy.
 * Throws {@link PolicyLoadError}; it never falls back to a weaker policy.
 */
export function loadCompiled(json: unknown): ICompiledPolicy {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new PolicyLoadError('malformed', 'compiled policy must be a JSON object');
  }
  const version = (json as Record<string, unknown>)['schemaVersion'];
  if (version !== 1) {
    throw new PolicyLoadError(
      'schema-version',
      `unsupported compiled policy schemaVersion ${JSON.stringify(version)}; expected 1`
    );
  }
  const issues = validateSchema(COMPILED_SCHEMA, json);
  if (issues.length > 0) {
    throw new PolicyLoadError(
      'malformed',
      `compiled policy is malformed at ${issues[0].path || '/'}: ${issues[0].message}`
    );
  }
  const copy = deepClone(json) as Record<string, unknown>;
  const { contentHash, ...body } = copy;
  if (sha256Hex(canonicalize(body)) !== contentHash) {
    throw new PolicyLoadError('hash-mismatch', 'compiled policy contentHash does not match its content');
  }
  return deepFreeze(copy) as unknown as ICompiledPolicy;
}
