import type { Attributes, AttributeValue, ICompiledPolicy, IResolved } from '../../spec';
import { deepClone, setOwn } from '../canonical/clone';
import { PolicyEvalError, describeThrown } from '../errors';
import { matchesPresent } from '../engine/matches';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `where` under the same present-only semantics as `context` (D-22); a rule that cannot be evaluated throws, it is never skipped. */
function ruleApplies(id: string, supplied: Record<string, AttributeValue>, where: NonNullable<ICompiledPolicy['defaults'][number]['where']>): boolean {
  try {
    return matchesPresent(supplied, where);
  } catch (error) {
    throw new PolicyEvalError(id, `defaults rule ${id} could not be evaluated: ${describeThrown(error)}`);
  }
}

/**
 * Applies `policy.defaults` to the supplied attributes. Supplied values are
 * final (AT-04). For each rule in order whose `where` matches the SUPPLIED
 * attributes under present-only semantics (a comparison on an attribute that
 * was not supplied is false, including `_ne`/`_nin`, D-22; an omitted `where` always matches, LY-02), each key in `set` is
 * written unless the key was supplied; a later matching rule overwrites an
 * earlier rule's value (LY-01); an explicit empty list stops inheritance
 * (LY-04). `provenance[key]` is `'supplied'` or the defaults rule id.
 * `attributes` undefined means `{}`. Attributes not declared in
 * `policy.attributes` are dropped (AT-11). Keys of the result are ascending.
 * Pure. Throws `PolicyEvalError` naming the rule when a `where` cannot be
 * evaluated (never treated as "does not apply"): callers that decide fail
 * closed on it.
 */
export function resolveAttributes(policy: ICompiledPolicy, supplied?: Attributes): IResolved {
  const suppliedDeclared: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(supplied ?? {})) {
    if (value !== undefined && value !== null && has(policy.attributes, key)) {
      setOwn(suppliedDeclared, key, deepClone(value));
    }
  }
  const values: Record<string, AttributeValue> = { ...suppliedDeclared };
  const provenance: Record<string, string> = {};
  for (const key of Object.keys(suppliedDeclared)) setOwn(provenance, key, 'supplied');

  for (const rule of policy.defaults) {
    if (rule.where !== undefined && !ruleApplies(rule.id, suppliedDeclared, rule.where)) continue;
    for (const [key, value] of Object.entries(rule.set)) {
      if (has(suppliedDeclared, key)) continue;
      setOwn(values, key, deepClone(value));
      setOwn(provenance, key, rule.id);
    }
  }
  const attributes: Record<string, AttributeValue> = {};
  const sortedProvenance: Record<string, string> = {};
  for (const key of Object.keys(values).sort()) {
    setOwn(attributes, key, values[key]);
    setOwn(sortedProvenance, key, provenance[key]);
  }
  return { attributes, provenance: sortedProvenance };
}
