import { ApiError } from '@adhd/apigen-base-errors';
import type { UsePlugin } from '@adhd/apigen-engine-runtime';
import { PolicyAttributes } from '@adhd/apigen-plugin-policy';
import type { IAttributesSource } from './attributes-source';

/**
 * The launcher-side stand-in for an auth layer (SC-03): on every call it awaits
 * `source.read()` and, when attributes are configured, writes them to the call's
 * `ctx` under the {@link PolicyAttributes} key (SPEC 8.1 rule 3: inter-Layer data
 * travels on `ctx`, never on the client-supplied envelope). The policy Layer reads
 * that key and nothing the caller sent, so a caller cannot assert its own
 * attributes (LP-09). A read failure is `ApiError('permission_denied')`.
 *
 * The layer is typed by `UsePlugin`'s capability, so `call` is the core-client
 * `Call` and `call.ctx` is its `Extensions` map; no cast is needed.
 *
 * @param source Where the caller's attributes come from; read once per call.
 * @returns A Layer plugin with id `adhd-policy-attributes`.
 */
export function createAttributesLayerPlugin(source: IAttributesSource): UsePlugin {
  return {
    id: 'adhd-policy-attributes',
    capabilities: {
      layer: {
        layer: async (call, next) => {
          let attributes;
          try {
            attributes = await source.read();
          } catch (error) {
            throw new ApiError('permission_denied', error instanceof Error ? error.message : 'attributes could not be read');
          }
          if (attributes !== undefined) call.ctx.set(PolicyAttributes, new PolicyAttributes(attributes));
          return next();
        },
      },
    },
  };
}
