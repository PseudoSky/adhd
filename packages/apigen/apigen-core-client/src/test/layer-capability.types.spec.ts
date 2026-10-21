/**
 * guards: a layer capability with neither `layer` nor `createLayer` type-checks (a plugin author ships a Layer that can never run), or a createLayer-only / layer-only plugin stops compiling against Plugin
 * tier: S
 * cites: REMEDIATION-PLAN T-R1 (scenario "a layer plugin exposes only createLayer"; R1 type-level behaviour change); MountedOperation.tool mirrors Operation.tool (commit 16a2b4fd)
 * tags: contract
 * teeth: red: alias `LayerCapability` to `LayerCapabilityShape<Opts>` in plugin.ts (guarded temporary edit, restored) and run `npx nx run apigen-core-client:typecheck-spec` -> exit 1; layer-capability.types.spec.ts goes 0 -> 2 type errors (the two `@ts-expect-error` rows become unused)
 *
 * The type-level assertions are proven by `typecheck-spec` (an unused `@ts-expect-error` is itself an error);
 * the runtime bodies only keep each case a named test.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Call,
  LayerCapability,
  MountedOperation,
  Next,
  Operation,
  Plugin,
} from '../index';

const passthrough = (_call: Call, next: Next) => next();

describe('LayerCapability (T-R1)', () => {
  it('accepts a plugin whose layer capability has only createLayer', () => {
    const plugin: Plugin = {
      id: 'create-only',
      capabilities: {
        layer: { createLayer: () => passthrough },
      },
    };
    expect(typeof plugin.capabilities.layer?.createLayer).toBe('function');
  });

  it('accepts a plugin whose layer capability has only layer', () => {
    const plugin: Plugin = {
      id: 'layer-only',
      capabilities: { layer: { layer: passthrough } },
    };
    expect(typeof plugin.capabilities.layer?.layer).toBe('function');
  });

  it('rejects a capability with neither layer nor createLayer', () => {
    // @ts-expect-error a LayerCapability needs `layer` or `createLayer`
    const neither: LayerCapability = {};
    // @ts-expect-error envelopeFields alone does not satisfy the capability either
    const onlyFields: LayerCapability = { envelopeFields: {} };
    expect([neither, onlyFields]).toHaveLength(2);
  });

  it('passes createLayer the typed options and returns a layer function', () => {
    const cap: LayerCapability<{ timeoutMs: number }> = {
      createLayer: (opts) => {
        expectTypeOf(opts.timeoutMs).toEqualTypeOf<number>();
        return passthrough;
      },
    };
    expect(cap.createLayer?.({ timeoutMs: 5 })).toBe(passthrough);
  });

  it('gives MountedOperation.tool the same shape as Operation.tool', () => {
    expectTypeOf<MountedOperation['tool']>().toEqualTypeOf<Operation['tool']>();
    expectTypeOf<NonNullable<Operation['tool']>>().toHaveProperty('description');
    expectTypeOf<NonNullable<Operation['tool']>>().toHaveProperty('outputSchema');
    // @ts-expect-error `description` is a string, not a number
    const bad: Operation['tool'] = { description: 1 };
    expect(bad).toBeDefined();
  });
});
