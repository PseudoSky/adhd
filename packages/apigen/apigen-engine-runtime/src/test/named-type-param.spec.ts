/**
 * Regression test for BUG-APIGEN-026 — real extract → compose → AJV-compile
 * pipeline, not hand-built schema fixtures.
 *
 * `validate-layer.spec.ts` (sibling file) proves the validateLayer's own
 * logic against HAND-WRITTEN `ComposedSchemas` fixtures — those never exposed
 * this bug, because the bug lives upstream, in what `generateSchemas()` /
 * `composeSchemas()` actually PRODUCE for a named-type parameter (e.g.
 * `type Choice = 'a' | 'b' | 'c'`; function pick(choice: Choice)`).
 *
 * Before the fix: `ts-json-schema-generator`'s own `topRef: true` default
 * (`apigen-core-client/src/lib/schema-builders/ts-json-schema.ts`) wrapped
 * `Choice`'s schema as `{ $ref: "#/definitions/Choice", definitions: {
 * Choice: {...} } }`. That whole fragment landed nested inside the composed
 * function schema at `properties.data.properties.choice`. JSON-Schema `$ref`
 * resolution is root-relative to the document AJV compiles, not
 * fragment-relative, so the `definitions` sibling — sitting at that same
 * nested depth, not the true document root — never resolved. AJV threw at
 * COMPILE time (`ajv.compile(schema.input)`), before any input was even
 * inspected — every call to `pick()` failed, regardless of the value sent.
 *
 * This test runs the REAL pipeline (`extract` → `composeSchemas` → the REAL
 * `validateLayer`/`Ajv` instance) against a fixture with exactly that shape,
 * so a regression here fails loudly instead of silently passing hand-built
 * fixtures that never exercised the real generator.
 *
 * v1 retirement (BUG-APIGEN-CORE-005): `generateSchemas()` (v1) is deleted.
 * `toGeneratedSchemas()` below adapts v2's `extract()` → `Operation[]` into
 * the `GeneratedSchemas` shape `composeSchemas()` expects — the exact same
 * adaptation `buildDescriptor`'s Step 5 performs in
 * `entrypoint/apigen-cli/src/lib/orchestrator.ts`, reproduced here since it
 * isn't exported as a standalone helper.
 */
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import type { Operation, GeneratedSchemas } from '@adhd/apigen-core-client';
import { createInvoker, LayerContext } from '../lib/invoke';
import { makeValidateLayer } from '../lib/validate-layer';
import type { Call } from '../lib/invoke';

const fixture = path.resolve(__dirname, 'fixtures', 'named-type-param.ts');

function makeCall(domainArgs: Record<string, unknown>): Call {
  return {
    operation: { id: 'pick' },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs,
  };
}

// Mirrors buildDescriptor's Step 5 adapter (orchestrator.ts): only
// `kind: 'action'` operations are dispatchable functions; the flat schema
// key is the terminal path segment's raw spelling.
function toGeneratedSchemas(operations: readonly Operation[]): GeneratedSchemas {
  const generated: GeneratedSchemas = {
    metadata: { namespace: '', phase: '' },
    schemas: {},
  };
  for (const op of operations) {
    if (op.kind !== 'action') continue;
    const fnName = op.path[op.path.length - 1].raw;
    generated.schemas[fnName] = {
      input: op.input,
      output: op.output,
      ...(op.hasCtx ? { hasCtx: true } : {}),
    };
  }
  return generated;
}

describe('BUG-APIGEN-026: named-type parameter schema — real pipeline', () => {
  it('[apigen-core-026.1] the composed schema for a named-type param compiles in AJV without a dangling $ref', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);

    // The bug threw at compile time, inside makeValidateLayer's ajv.compile()
    // call — constructing the layer over this schema must not throw.
    expect(() => makeValidateLayer(schemas)).not.toThrow();
  });

  it('[apigen-core-026.2] a valid call to pick() passes through to dispatch', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);
    const dispatchSpy = vi.fn().mockResolvedValue('a');

    const invoke = createInvoker([makeValidateLayer(schemas)]);
    const result = await invoke('pick', makeCall({ choice: 'a' }), {
      fns: { pick: dispatchSpy },
      schemas,
    });

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(result).toBe('a');
  });

  it('[apigen-core-026.3] the literal union is a real enum constraint — an invalid choice is rejected, not silently accepted', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);
    const dispatchSpy = vi.fn();

    const invoke = createInvoker([makeValidateLayer(schemas)]);
    await expect(
      invoke('pick', makeCall({ choice: 'not-a-valid-choice' }), {
        fns: { pick: dispatchSpy },
        schemas,
      })
    ).rejects.toThrow(/invalid_argument|Validation failed/);

    // Negative-control latch: dispatch must never be reached for invalid input.
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
