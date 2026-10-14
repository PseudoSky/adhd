import type {
  AttributeValue,
  Attributes,
  ICompiledPolicy,
  INarrowRequest,
  INarrowResult,
} from '../../spec';
import { setOwn } from '../canonical/clone';
import { isWithin, unionValues } from './merge';
import { valueMatchesKind } from './kinds';
import { resolveAttributes } from './resolve';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Narrows a parent's attributes for a child (MG-01..MG-11, NR-01..NR-04).
 * Pure; the parent is never mutated; keys are processed in ascending order so
 * the FIRST failure is deterministic.
 *
 * 1. `S` = the child's effective attributes from `request.attributes` plus
 *    matching defaults (supplied values are final).
 * 2. Every key of `grant`/`only` must be declared AND covered by a narrowing
 *    check (NR-04, else rule `uncovered`), not supplied (`supplied-final`),
 *    and of the declared kind (`type`).
 * 3. Add step per key: in `S` and `grant` -> union; only `S` -> `S`; only
 *    `grant` -> `grant`; neither -> the parent's value.
 * 4. `only[key]` must lie within the add result (`only-outside`, MG-07) and
 *    replaces it (MG-05); `grant` applies before `only` (MG-06).
 * 5. Every completed key must lie within the parent (`exceeds-parent`,
 *    MG-08/MG-09: refused, never clamped). This includes SUPPLIED keys the
 *    policy narrows (a key in `narrowingCovered`): a supplied value is final but
 *    cannot exceed the parent, and a parent that lacks the key refuses it. A
 *    supplied key no narrowing check covers (e.g. `role`) passes through.
 *
 * A refusal names the variable and the rule (EX-04).
 */
export function narrowAttributes(
  policy: ICompiledPolicy,
  parent: Attributes,
  request: INarrowRequest
): INarrowResult {
  const refuse = (variable: string, rule: string, reason: string): INarrowResult => ({
    ok: false,
    variable,
    rule,
    reason,
  });
  try {
    const grant: Attributes = request.grant ?? {};
    const only: Attributes = request.only ?? {};
    const parentValues: Attributes = parent ?? {};
    const resolved = resolveAttributes(policy, request.attributes);
    const S = resolved.attributes;
    const suppliedKeys = new Set(
      Object.keys(resolved.provenance).filter((k) => resolved.provenance[k] === 'supplied')
    );
    const covered = new Set(Object.values(policy.narrowingCovered).flat());

    const requested = [...new Set([...Object.keys(grant), ...Object.keys(only)])].sort();
    for (const key of requested) {
      if (!has(policy.attributes, key) || !covered.has(key)) {
        return refuse(key, 'uncovered', `"${key}" cannot be granted or restricted: no narrowing check covers it (NR-04)`);
      }
      if (suppliedKeys.has(key)) {
        return refuse(key, 'supplied-final', `"${key}" is supplied by the child request and is final; grant/only cannot change it`);
      }
      const kind = policy.attributes[key];
      for (const [label, source] of [['grant', grant], ['only', only]] as const) {
        if (has(source, key) && !valueMatchesKind(kind, source[key])) {
          return refuse(key, 'type', `"${key}" in ${label} must be a ${kind} value`);
        }
      }
    }

    const completedKeys = [
      ...new Set([
        ...Object.keys(parentValues),
        ...Object.keys(S),
        ...Object.keys(grant),
        ...Object.keys(only),
      ]),
    ]
      .filter((k) => has(policy.attributes, k))
      .sort();

    const child: Record<string, AttributeValue> = {};
    for (const key of completedKeys) {
      const kind = policy.attributes[key];
      const parentValue =
        has(parentValues, key) && valueMatchesKind(kind, parentValues[key]) ? parentValues[key] : undefined;
      if (suppliedKeys.has(key)) {
        // A supplied value is final, but it is still a request for authority: a key
        // the policy narrows must lie within the parent (C1); other keys (e.g. `role`) pass through.
        if (covered.has(key)) {
          if (!valueMatchesKind(kind, S[key])) {
            return refuse(key, 'type', `"${key}" in the supplied attributes must be a ${kind} value`);
          }
          if (parentValue === undefined || !isWithin(kind, S[key], parentValue)) {
            return refuse(key, 'exceeds-parent', `"${key}" is supplied by the child request but would exceed the parent's authority`);
          }
        }
        const supplied = S[key];
        setOwn(child, key, Array.isArray(supplied) ? [...supplied] : supplied);
        continue;
      }
      const inS = has(S, key);
      const inGrant = has(grant, key);
      let add: AttributeValue | undefined;
      if (inS && inGrant) add = unionValues(kind, S[key], grant[key]);
      else if (inS) add = S[key];
      else if (inGrant) add = grant[key];
      else add = parentValue;

      let completed = add;
      if (has(only, key)) {
        if (add === undefined || !isWithin(kind, only[key], add)) {
          return refuse(key, 'only-outside', `"${key}": the requested "only" value is not within what the child would otherwise have`);
        }
        completed = only[key];
      }
      if (completed === undefined) continue;
      if (parentValue === undefined || !isWithin(kind, completed, parentValue)) {
        return refuse(key, 'exceeds-parent', `"${key}" would exceed the parent's authority`);
      }
      setOwn(child, key, Array.isArray(completed) ? [...completed] : completed);
    }
    return { ok: true, child };
  } catch (error) {
    return refuse('', 'error', `narrowing failed closed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
