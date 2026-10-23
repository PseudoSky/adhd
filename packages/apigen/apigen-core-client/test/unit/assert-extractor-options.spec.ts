/**
 * guards: an option that cannot be keyed (function, cycle, non-finite number, class instance) or a mistyped tsconfig / dropFileSegment reaches an extractor and silently changes an ir-cache key
 * tier: S
 * cites: REMEDIATION-PLAN T-R1 / R5 (single IR-generation entry, ExtractCall.extractorOptions contract); extract-invoker.ts assertExtractorOptions
 * tags: contract
 * teeth: red: make `isJsonLike` return true for 'function' (guarded temporary edit, restored) and run `npx vitest run src/test/assert-extractor-options.spec.ts` in packages/apigen/apigen-core-client -> exit 1; "rejects a function value" goes red
 */
import { describe, expect, it } from 'vitest';
import { assertExtractorOptions } from '../../src/index';

class Handle {
  readonly open = true;
}

describe('assertExtractorOptions', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['undefined', undefined],
    ['an empty bag', {}],
    ['known keys of the right type', { tsconfig: './tsconfig.json', dropFileSegment: true }],
    ['unknown JSON-like keys incl. nested arrays and null', { extra: { a: [1, [2, null], 'x'], b: false } }],
    ['a run-scoped session handle of any shape', { session: new Handle() }],
    ['a null-prototype object', { bag: Object.assign(Object.create(null) as object, { a: 1 }) }],
  ])('accepts %s', (_name, options) => {
    expect(() => assertExtractorOptions(options)).not.toThrow();
  });

  it.each<[string, string, unknown]>([
    ['a function value', 'run', () => 1],
    ['a non-finite number', 'limit', Number.POSITIVE_INFINITY],
    ['NaN', 'nan', Number.NaN],
    ['a Date (wrong prototype)', 'when', new Date(0)],
    ['a class instance', 'handle', new Handle()],
    ['undefined nested in an array', 'list', [1, undefined]],
    ['a symbol', 'sym', Symbol('s')],
  ])('rejects %s and names the key', (_name, key, value) => {
    expect(() => assertExtractorOptions({ [key]: value })).toThrow(
      new RegExp(`extractorOptions\\.${key} is not plain JSON data`)
    );
  });

  it('rejects a cyclic value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => assertExtractorOptions({ cyclic })).toThrow(/extractorOptions\.cyclic is not plain JSON data/);
  });

  it('accepts a shared (non-cyclic) reference used twice', () => {
    const shared = { a: 1 };
    expect(() => assertExtractorOptions({ x: shared, y: [shared, shared] })).not.toThrow();
  });

  it('rejects a non-string tsconfig', () => {
    expect(() => assertExtractorOptions({ tsconfig: 1 })).toThrow(/tsconfig must be a string/);
  });

  it('rejects a non-boolean dropFileSegment', () => {
    expect(() => assertExtractorOptions({ dropFileSegment: 'x' })).toThrow(/dropFileSegment must be a boolean/);
  });
});
