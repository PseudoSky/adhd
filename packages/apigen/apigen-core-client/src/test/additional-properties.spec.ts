/**
 * Regression tests for the BUG-BACKLOG-QUERY-001 root cause.
 *
 * Root cause (same fall-through class as BUG-APIGEN-CORE-CLIENT-001, see
 * required-fields.spec.ts): a named interface used as a function-parameter
 * type resolves, via `p.getTypeAtLocation(sig.getDeclaration()).getText()`
 * (extract.ts's `rawParams`/`rawParamsFromSig`, called with NO enclosing-node
 * context), to a fully-qualified `import("<abs path>").TypeName` expression —
 * not the bare type name. `buildSchema`'s Path 1 (ts-json-schema-generator)
 * cannot resolve that qualified-import string as a root type name, throws,
 * and falls through to Path 2 (`morph-walk.ts`'s `walkType`).
 *
 * ts-json-schema-generator's own `DEFAULT_CONFIG` (`Config.js`) closes every
 * object schema (`additionalProperties: false`) — but that default only
 * applies on Path 1. Path 2's object branch built `properties` (and, after
 * BUG-APIGEN-CORE-CLIENT-001, `required`) but never emitted
 * `additionalProperties` at all, so every object type reaching Path 2 —
 * which the required-fields fix's own doc comment calls "the common case for
 * a named interface used as a function-parameter type", i.e. the TOP-LEVEL
 * domain-param object of essentially every apigen-mounted operation — landed
 * with an OPEN schema.
 *
 * Confirmed in production: `entrypoint/backlog`'s `backlog_query` accepted a
 * mis-nested top-level `{"grep":"x"}` (the correct shape is
 * `{"filter":{"grep":"x"}}`) with `ok:true` and the ENTIRE unfiltered result
 * set, instead of a validation error — because (a) the open schema let AJV's
 * validate-Layer pass the call through unrejected, and (b) even so,
 * `dispatch.ts`'s `decodeArg` → `apigen-base-logical`'s `decodeNode` object
 * arm reconstructs the object from ONLY the schema's declared `properties`,
 * so the unrecognized `grep` key silently vanished before the target
 * function ever saw it either way. See entrypoint/backlog's own
 * `query.additional-properties.spec.ts` for the end-to-end proof through the
 * real `backlogQuery` operation.
 *
 * Fix: packages/apigen/apigen-core-client/src/lib/schema-builders/morph-walk.ts's
 * `walkType` object branch now emits `additionalProperties: false` on every
 * object schema it builds, matching ts-json-schema-generator's own default
 * and Path 1's behavior.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { extract } from '../index';
import type { GeneratedSchemas } from '../lib/types';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);

const _genCache = new Map<string, Promise<GeneratedSchemas>>();
function gen(sourceFile: string): Promise<GeneratedSchemas> {
  let p = _genCache.get(sourceFile);
  if (!p) {
    p = extract({ sourceFile }).then((ops) => {
      const schemas: GeneratedSchemas['schemas'] = {};
      for (const op of ops) {
        if (op.kind !== 'action') continue;
        const name = op.path.at(-1)?.raw;
        if (!name) continue;
        schemas[name] = {
          input: op.input,
          output: op.output,
          ...(op.hasCtx ? { hasCtx: true } : {}),
        };
      }
      return { metadata: { namespace: '', phase: '' }, schemas };
    });
    _genCache.set(sourceFile, p);
  }
  return p;
}

describe('BUG-BACKLOG-QUERY-001 root cause: Path 2 (morph-walk) object schemas are closed by default', () => {
  it('[additionalProperties.named-param-mixed] a named-interface param with required + optional fields (Path 2) gets additionalProperties:false', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createThing']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    // Teeth: this is exactly the assertion the pre-fix walker fails —
    // reverting the `additionalProperties: false` line in morph-walk.ts's
    // object branch turns this red (the key is absent entirely, not merely
    // `true`).
    expect(nested.additionalProperties).toBe(false);
  });

  it('[additionalProperties.named-param-all-optional] a Path-2 object with zero required fields still gets additionalProperties:false', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createOptionalThing']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    expect(nested.additionalProperties).toBe(false);
  });

  it('[additionalProperties.create-item-input-shaped] a CreateItemInput-shaped real-world Path-2 object gets additionalProperties:false', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createItemShaped']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    expect(nested.additionalProperties).toBe(false);
  });

  it('[additionalProperties.mixed-named-and-index] a Path-2 object with BOTH named properties AND a string index signature is NOT closed — additionalProperties becomes the index value schema, not false', async () => {
    const result = await gen(fixture('required-fields.ts'));
    const inputSchema = result.schemas['createMixedIndexedThing']?.input as Record<
      string,
      unknown
    >;
    const nested = (inputSchema.properties as Record<string, unknown>)[
      'input'
    ] as Record<string, unknown>;

    // Teeth: an unconditional `additionalProperties: false` (the naive fix)
    // would reject legitimate extra keys the index signature explicitly
    // allows. The correct fix narrows `additionalProperties` to the index
    // signature's own resolved value schema instead of closing the object.
    expect(nested.additionalProperties).not.toBe(false);
    expect(nested.additionalProperties).toEqual({ type: 'string' });
  });
});
