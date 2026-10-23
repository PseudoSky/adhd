import type {
  Attributes,
  ICompiledPermission,
  ICompiledPolicy,
  IDecision,
  IExplanation,
  IResolved,
  IRuntimeValues,
  IToolCall,
} from '../../spec';
import { resolveAttributes } from '../attributes/resolve';
import { describeThrown } from '../errors';
import { matches, matchesPresent } from '../engine/matches';
import { selectPermissions } from './select';
import { substitute } from './substitute';

type Considered = IExplanation['considered'][number];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const deny = (
  code: NonNullable<IDecision['denial']>['code'],
  reason: string,
  matched: readonly string[] = []
): IDecision => ({ effect: 'deny', set: {}, matched, denial: { code, reason } });

/**
 * Shared engine for `evaluate` and `explain`. Procedure (spec 4.3, D-02, D-13):
 * 1. select permissions by tool; 2. resolve effective attributes; any selected
 * permission that reads `runtime` while `runtime` is undefined denies
 * `runtime-unavailable` (RT-09); 3. the context row is `{...attrs, runtime}`
 * and a permission is applicable iff it has no `context` or the context
 * matches; 4. for applicable permissions `args` has `$attributes.*`
 * substituted and is matched against the call arguments; 5. `matched` lists
 * every permission whose context and args both pass, in order; deny wins over
 * ask over allow, none is deny `no-match`; 6. `set` merges the forced values
 * of matching allow/ask permissions, two permissions forcing different values
 * for one key deny `eval-error`; 7. any exception denies `eval-error` (FC-01).
 * `set` is `{}` on deny. Never reads the clock, environment or filesystem.
 * `considered` lists EVERY permission selected by tool (D-12), with
 * `substituted` set only for applicable permissions that have `args`.
 *
 * A permission whose `context` or `args` cannot be evaluated (an uncompilable
 * regular expression, including one supplied through an attribute) denies the
 * whole call `eval-error` with a reason naming the permission id: a `deny` rule
 * that cannot be evaluated must never read as "does not match" (FC-01).
 * `resolved` is an internal optimisation: a caller that already ran
 * `resolveAttributes(policy, attributes)` passes the result so it is not
 * computed twice; it must be exactly that result.
 */
export function evaluateDetailed(
  policy: ICompiledPolicy,
  call: IToolCall,
  attributes?: Attributes,
  runtime?: IRuntimeValues,
  resolved?: IResolved
): IExplanation {
  try {
    if (call === null || typeof call !== 'object' || typeof call.tool !== 'string' || call.tool === '') {
      return { decision: deny('eval-error', 'the tool call has no tool name'), considered: [] };
    }
    const selected = selectPermissions(policy, call.tool);
    const unreviewed = (): Considered[] =>
      selected.map((p) => ({ id: p.id, applicable: false, substituted: undefined }));
    const readers = selected.filter((p) => p.readsRuntime);
    if (readers.length > 0 && runtime === undefined) {
      return {
        decision: deny(
          'runtime-unavailable',
          `permission ${readers.map((p) => p.id).join(', ')} reads runtime values and none were supplied`
        ),
        considered: unreviewed(),
      };
    }

    const effective = (resolved ?? resolveAttributes(policy, attributes)).attributes;
    const contextRow: Record<string, unknown> = { ...effective };
    if (runtime !== undefined) contextRow['runtime'] = runtime;
    const argsRow: Record<string, unknown> =
      call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args) ? { ...call.args } : {};

    const considered: Considered[] = [];
    const hits: ICompiledPermission[] = [];
    for (const permission of selected) {
      try {
        const contextMatched = permission.context === undefined || matchesPresent(contextRow, permission.context);
        if (!contextMatched) {
          considered.push({ id: permission.id, applicable: false, contextMatched: false, substituted: undefined });
          continue;
        }
        let argsMatched = true;
        let substituted: Considered['substituted'];
        if (permission.args !== undefined) {
          substituted = substitute(permission.args, effective).expression;
          argsMatched = matches(argsRow, substituted);
        }
        considered.push({ id: permission.id, applicable: true, contextMatched: true, argsMatched, substituted });
        if (argsMatched) hits.push(permission);
      } catch (error) {
        const reviewed = new Set(considered.map((c) => c.id));
        return {
          decision: deny(
            'eval-error',
            `permission ${permission.id} could not be evaluated: ${describeThrown(error)}`
          ),
          considered: [
            ...considered,
            ...selected
              .filter((p) => !reviewed.has(p.id))
              .map((p) => ({ id: p.id, applicable: false, substituted: undefined })),
          ],
        };
      }
    }

    const matched = hits.map((p) => p.id);
    const denies = hits.filter((p) => p.effect === 'deny');
    if (denies.length > 0) {
      return {
        decision: deny('explicit-deny', `denied by permission ${denies.map((p) => p.id).join(', ')}`, matched),
        considered,
      };
    }
    const asks = hits.filter((p) => p.effect === 'ask');
    const allows = hits.filter((p) => p.effect === 'allow');
    if (asks.length === 0 && allows.length === 0) {
      return {
        decision: deny('no-match', `no permission allows ${call.tool}`, matched),
        considered,
      };
    }
    const set: Record<string, unknown> = {};
    const owners: Record<string, string> = {};
    for (const permission of [...asks, ...allows].sort((a, b) => hits.indexOf(a) - hits.indexOf(b))) {
      for (const [key, value] of Object.entries(permission.set ?? {})) {
        if (Object.prototype.hasOwnProperty.call(set, key) && !same(set[key], value)) {
          return {
            decision: deny(
              'eval-error',
              `permissions ${owners[key]} and ${permission.id} force different values for "${key}"`,
              matched
            ),
            considered,
          };
        }
        Object.defineProperty(set, key, { value, enumerable: true, writable: true, configurable: true });
        Object.defineProperty(owners, key, { value: permission.id, enumerable: true, writable: true, configurable: true });
      }
    }
    const effect = asks.length > 0 ? 'ask' : 'allow';
    return { decision: { effect, set, matched }, considered };
  } catch (error) {
    return {
      decision: deny('eval-error', `evaluation failed closed: ${describeThrown(error)}`),
      considered: [],
    };
  }
}

/** Evaluates a tool call: deny beats ask beats allow, no match is deny, never throws (CL-08, FC-01). */
export function evaluate(
  policy: ICompiledPolicy,
  call: IToolCall,
  attributes?: Attributes,
  runtime?: IRuntimeValues,
  resolved?: IResolved
): IDecision {
  return evaluateDetailed(policy, call, attributes, runtime, resolved).decision;
}
