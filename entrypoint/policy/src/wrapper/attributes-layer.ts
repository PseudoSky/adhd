import { ApiError } from '@adhd/apigen-base-errors';
import type { Call, UsePlugin } from '@adhd/apigen-engine-runtime';
import type { IAttributesSource } from './attributes-source';

/**
 * The launcher-side stand-in for an auth layer (SC-03): on every call it awaits
 * `source.read()` and writes the result to `call.envelope.attributes`,
 * overwriting whatever a caller put there, so a caller cannot assert its own
 * attributes (LP-09). A read failure is `ApiError('permission_denied')`.
 */
export function createAttributesLayerPlugin(source: IAttributesSource): UsePlugin {
  return {
    id: 'adhd-policy-attributes',
    capabilities: {
      layer: {
        layer: async (rawCall, next) => {
          const call = rawCall as Call;
          let attributes;
          try {
            attributes = await source.read();
          } catch (error) {
            throw new ApiError('permission_denied', error instanceof Error ? error.message : 'attributes could not be read');
          }
          if (attributes === undefined) delete call.envelope['attributes'];
          else call.envelope['attributes'] = attributes;
          return next();
        },
      },
    },
  };
}
