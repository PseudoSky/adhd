import { describe, expect, it } from 'vitest';

import { isEnvRef, makeEnvRef } from '@adhd/environment-base-spec';
import { coerceValue, resolveConfig, unflatten } from '../config-resolver';
import type { Layers } from '../layer-files';

const EMPTY_LAYERS: Layers = { system: undefined, global: undefined, project: undefined, local: undefined };

/** Reads a dot-path out of a `Record<string, unknown>` tree without resorting to `any`. */
function get(obj: Record<string, unknown>, path: string): unknown {
  let node: unknown = obj;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('coerceValue', () => {
  it('coerces integer/number/boolean/array from string forms', () => {
    expect(coerceValue('42', 'integer')).toBe(42);
    expect(coerceValue('3.14', 'number')).toBe(3.14);
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('false', 'boolean')).toBe(false);
    expect(coerceValue('a,b,c', 'array')).toEqual(['a', 'b', 'c']);
  });

  it('leaves already-typed values unchanged', () => {
    expect(coerceValue(42, 'integer')).toBe(42);
    expect(coerceValue(true, 'boolean')).toBe(true);
  });

  it('returns the original value unchanged on invalid coercion (validation is a separate concern)', () => {
    expect(coerceValue('not-a-number', 'integer')).toBe('not-a-number');
  });
});

describe('unflatten', () => {
  it('rebuilds a nested tree from dot-path keys', () => {
    expect(unflatten({ 'a.b': 1, 'a.c': 2, d: 3 })).toEqual({ a: { b: 1, c: 2 }, d: 3 });
  });
});

describe('resolveConfig — the defaults→system→global→project→local→env cascade', () => {
  const ctx = { prefix: 'ADHD_T', activeScope: 'global' as const };

  it('zero-config: with no layers and no env var, the field default applies', () => {
    const { nested, provenance } = resolveConfig({ 'a.port': { type: 'integer', default: 8787 } }, EMPTY_LAYERS, {}, ctx);
    expect(get(nested, 'a.port')).toBe(8787);
    expect(provenance['a.port']).toEqual({ source: 'default', scope: 'global' });
  });

  it('negative control: an UNDECLARED field never appears, proving the fallback comes from the real default (not a stray global)', () => {
    const { nested } = resolveConfig({ 'a.port': { type: 'integer', default: 8787 } }, EMPTY_LAYERS, {}, ctx);
    expect(get(nested, 'a.missing')).toBeUndefined();
  });

  it('a system-layer file value overrides the spec default', () => {
    const layers: Layers = { ...EMPTY_LAYERS, system: { 'a.port': 1000 } };
    const { provenance, nested } = resolveConfig({ 'a.port': { type: 'integer', default: 8787 } }, layers, {}, ctx);
    expect(get(nested, 'a.port')).toBe(1000);
    expect(provenance['a.port'].source).toBe('system');
  });

  it('global overrides system; project overrides global; local overrides project (strict cascade order)', () => {
    const layers: Layers = {
      system: { 'a.port': 1 },
      global: { 'a.port': 2 },
      project: { 'a.port': 3 },
      local: { 'a.port': 4 },
    };
    const { nested } = resolveConfig({ 'a.port': { type: 'integer', default: 0 } }, layers, {}, ctx);
    expect(get(nested, 'a.port')).toBe(4);
  });

  it('project overrides global when local is absent', () => {
    const layers: Layers = { system: undefined, global: { 'a.port': 2 }, project: { 'a.port': 3 }, local: undefined };
    const { nested } = resolveConfig({ 'a.port': { type: 'integer', default: 0 } }, layers, {}, ctx);
    expect(get(nested, 'a.port')).toBe(3);
  });

  it('an env var overrides every file layer (highest precedence)', () => {
    const layers: Layers = { system: { 'a.port': 1 }, global: { 'a.port': 2 }, project: { 'a.port': 3 }, local: { 'a.port': 4 } };
    const { nested, provenance } = resolveConfig(
      { 'a.port': { type: 'integer', default: 0 } },
      layers,
      { ADHD_T_A_PORT: '9999' },
      ctx,
    );
    expect(get(nested, 'a.port')).toBe(9999);
    expect(provenance['a.port']).toEqual({ source: 'env', scope: 'global', env: 'ADHD_T_A_PORT' });
  });

  it('an explicit FieldSpec.env name is used instead of the inferred name', () => {
    const { fields } = resolveConfig({ 'a.port': { type: 'integer', env: 'CUSTOM_PORT_VAR' } }, EMPTY_LAYERS, {}, ctx);
    expect(fields['a.port'].env).toBe('CUSTOM_PORT_VAR');
  });

  it('a live (at:"runtime") field is stored as an env-ref, never the plaintext, and its provenance source is always "env"', () => {
    const layers: Layers = { ...EMPTY_LAYERS, project: { 'db.secret': 'plaintext-should-never-appear' } };
    const { raw, nested, provenance, fields } = resolveConfig(
      { 'db.secret': { type: 'string', at: 'runtime' } },
      layers,
      {},
      ctx,
    );
    expect(isEnvRef(raw['db.secret'])).toBe(true);
    expect(raw['db.secret']).toBe(makeEnvRef(fields['db.secret'].env));
    expect(isEnvRef(get(nested, 'db.secret'))).toBe(true);
    expect(JSON.stringify(nested)).not.toContain('plaintext-should-never-appear');
    expect(provenance['db.secret']).toEqual({ source: 'env', scope: 'global', env: fields['db.secret'].env });
    // The pre-redaction typed value is still captured for validation purposes:
    expect(fields['db.secret'].fallbackValue).toBe('plaintext-should-never-appear');
  });

  it('a secret:true field behaves like at:"runtime" even without an explicit `at`', () => {
    const { raw, fields } = resolveConfig({ 'db.secret': { type: 'string', secret: true } }, EMPTY_LAYERS, {}, ctx);
    expect(fields['db.secret'].live).toBe(true);
    expect(isEnvRef(raw['db.secret'])).toBe(true);
  });

  it('a build (default) field is a plain value, never an env-ref', () => {
    const { raw, fields } = resolveConfig({ 'a.port': { type: 'integer', default: 1 } }, EMPTY_LAYERS, {}, ctx);
    expect(fields['a.port'].live).toBe(false);
    expect(isEnvRef(raw['a.port'])).toBe(false);
    expect(raw['a.port']).toBe(1);
  });

  it('coerces an env var string value according to the field type', () => {
    const { nested } = resolveConfig(
      { 'transport.port': { type: 'integer', default: 0 } },
      EMPTY_LAYERS,
      { ADHD_T_TRANSPORT_PORT: '4000' },
      ctx,
    );
    expect(get(nested, 'transport.port')).toBe(4000);
    expect(typeof get(nested, 'transport.port')).toBe('number');
  });

  it('a field-level scope override is recorded in provenance instead of the active scope', () => {
    const { provenance } = resolveConfig({ 'a.port': { type: 'integer', default: 1, scope: 'system' } }, EMPTY_LAYERS, {}, ctx);
    expect(provenance['a.port'].scope).toBe('system');
  });
});
