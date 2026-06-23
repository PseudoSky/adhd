import { describe, expect, it } from 'vitest';
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  LOGICAL_TYPE_VERSION,
  logicalKindOf,
  codecIdOf,
} from './descriptor-ext';
import type { SchemaNode } from './contracts';

/**
 * Proof for invariant [inv:hints-advisory]: the `x-apigen-*` keys are OPTIONAL —
 * the readers return `undefined` (never throw) when a key is absent or malformed.
 */
describe('descriptor-ext hint readers ([inv:hints-advisory])', () => {
  it('exposes a pinned wire-table version', () => {
    expect(LOGICAL_TYPE_VERSION).toBe('0.1.0');
  });

  it('reads a present, well-formed kind/codec hint', () => {
    const node: SchemaNode = {
      [X_APIGEN_LOGICAL]: 'nominal',
      [X_APIGEN_CODEC]: 'cli.User',
    };
    expect(logicalKindOf(node)).toBe('nominal');
    expect(codecIdOf(node)).toBe('cli.User');
  });

  it('returns undefined (never throws) when the hint is absent', () => {
    const node: SchemaNode = { type: 'object' };
    expect(logicalKindOf(node)).toBeUndefined();
    expect(codecIdOf(node)).toBeUndefined();
  });

  it('returns undefined for a malformed/unrecognized hint value', () => {
    expect(logicalKindOf({ [X_APIGEN_LOGICAL]: 'not-a-kind' })).toBeUndefined();
    expect(logicalKindOf({ [X_APIGEN_LOGICAL]: 42 })).toBeUndefined();
    expect(codecIdOf({ [X_APIGEN_CODEC]: 42 })).toBeUndefined();
  });
});
