/**
 * The ctx key that carries a caller's attributes to the policy Layer
 * (SPEC §8.1 rule 3: inter-Layer data travels on `ctx`, never on the
 * client-supplied envelope).
 *
 * An earlier Layer (an auth layer) writes it:
 *
 * ```ts
 * call.ctx.set(PolicyAttributes, new PolicyAttributes({ team: 'core' }));
 * ```
 *
 * and the policy Layer reads `call.ctx.get(PolicyAttributes)` and hands the
 * validated values to the decider as `IPolicyDecideRequest.attributes`.
 *
 * The class is the key, so the writer and the policy Layer must import it from
 * the same module instance: always import it from `@adhd/apigen-plugin-policy`.
 * A separately bundled copy is a different class and its value is not seen.
 */
export class PolicyAttributes {
  /**
   * @param values Attribute values: strings, finite numbers or string arrays.
   *   Any other value makes the policy Layer treat the call as having no
   *   attributes.
   */
  constructor(readonly values: Readonly<Record<string, string | number | readonly string[]>>) {}
}
