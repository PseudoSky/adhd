import type { FilterExpression, ICompiledPolicy } from '../../spec';
import { COMPILED_SCHEMA } from '../../spec';
import { canonicalize } from '../canonical/canonical';
import { deepClone, deepFreeze } from '../canonical/clone';
import { sha256Hex } from '../canonical/sha256';
import { validateExpression } from '../engine/validate';
import { PolicyLoadError } from '../errors';
import { validateSchema } from '../schema/validate';
import { toolIdProblem, type CanonicalToolId, type IToolIdOptions } from './tool-ids';

/**
 * Loads a stored compiled policy (CL-13). Validates against `COMPILED_SCHEMA`
 * (code `malformed`), requires `schemaVersion === 1` (`schema-version`) and
 * recomputes `contentHash` (`hash-mismatch`; this detects corruption, not
 * tampering: anyone who can edit the file can recompute the hash), then checks
 * that every stored expression passes `validateExpression` (an unsupported
 * operator is `malformed`), that no permission tool uses the pre-BA-5 `.`
 * separator (`malformed`, naming the `/` id; canonical when
 * `options.canonicalToolId` is set), that, with `options.canonicalToolId`, every
 * `/` tool is a canonical operation id (`malformed`, naming the canonical id),
 * and that every `index` entry
 * points at an existing permission. Returns a deep-frozen copy. Throws {@link PolicyLoadError}; it
 * never falls back to a weaker policy.
 */
export function loadCompiled(json: unknown, options?: IToolIdOptions): ICompiledPolicy {
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
  const policy = copy as unknown as ICompiledPolicy;
  checkExpressions(policy);
  checkToolIds(policy, options?.canonicalToolId);
  checkIndex(policy);
  return deepFreeze(copy) as unknown as ICompiledPolicy;
}

function checkExpressions(policy: ICompiledPolicy): void {
  const check = (where: string, expression: FilterExpression | undefined): void => {
    if (expression === undefined) return;
    const bad = validateExpression(expression, '');
    if (bad.length > 0) {
      throw new PolicyLoadError('malformed', `compiled policy is malformed at ${where}: unsupported or invalid expression at ${bad[0] === '' ? '/' : bad[0]}`);
    }
  };
  policy.permissions.forEach((permission, i) => {
    check(`/permissions/${i}/context`, permission.context);
    check(`/permissions/${i}/args`, permission.args);
  });
  policy.defaults.forEach((rule, i) => check(`/defaults/${i}/where`, rule.where));
}

function checkToolIds(policy: ICompiledPolicy, canonicalToolId: CanonicalToolId | undefined): void {
  policy.permissions.forEach((permission, i) => {
    permission.tools.forEach((tool, t) => {
      const problem = toolIdProblem(tool, canonicalToolId);
      if (problem !== undefined) {
        throw new PolicyLoadError('malformed', `compiled policy is malformed at /permissions/${i}/tools/${t}: ${problem.message}`);
      }
    });
  });
}

function checkIndex(policy: ICompiledPolicy): void {
  const count = policy.permissions.length;
  const inRange = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < count;
  const lists: [string, readonly unknown[]][] = [
    ...Object.entries(policy.index.exact).map(([tool, rules]) => [`/index/exact/${tool}`, rules] as [string, readonly unknown[]]),
    ...policy.index.patterns.map((pattern, i) => [`/index/patterns/${i}/rules`, pattern.rules] as [string, readonly unknown[]]),
  ];
  for (const [where, rules] of lists) {
    if (!rules.every(inRange)) {
      throw new PolicyLoadError('malformed', `compiled policy is malformed at ${where}: an index entry does not point at a permission (0..${count - 1})`);
    }
  }
}
