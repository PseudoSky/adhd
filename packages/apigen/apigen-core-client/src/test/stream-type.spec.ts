// stream-type.spec.ts — unit tests for `detectStreamElementType`
// (SPEC §11) — BUG-APIGEN-STREAMING-EXTRACT-001.
//
// Direct unit tests on the text-parsing helper (as opposed to
// extract.spec.ts / extract-classes.spec.ts, which exercise it end-to-end
// through the real ts-morph `Signature.getReturnType().getText()` pipeline).
// This layer specifically covers the union/defensive-guard case: a
// TypeScript `Project` with default (non-strict) compiler options collapses
// `T | null` to `T` at the checker level (`strictNullChecks` off), so that
// shape can never actually reach `detectStreamElementType` through the real
// extractor pipeline in this test suite — testing the guard here, on the
// pure function, is the only reliable way to cover it.

import { describe, it, expect } from 'vitest';
import { detectStreamElementType } from '../lib/stream-type';

describe('detectStreamElementType', () => {
  it('[stream-type.1] unwraps AsyncGenerator<T, TReturn, TNext> to T', () => {
    expect(
      detectStreamElementType('AsyncGenerator<Chunk, void, unknown>')
    ).toBe('Chunk');
  });

  it('[stream-type.2] unwraps AsyncGenerator<T> (no TReturn/TNext) to T', () => {
    expect(detectStreamElementType('AsyncGenerator<Chunk>')).toBe('Chunk');
  });

  it('[stream-type.3] unwraps AsyncIterable<T> to T', () => {
    expect(detectStreamElementType('AsyncIterable<Chunk>')).toBe('Chunk');
  });

  it('[stream-type.4] unwraps AsyncIterableIterator<T> to T', () => {
    expect(detectStreamElementType('AsyncIterableIterator<Chunk>')).toBe(
      'Chunk'
    );
  });

  it('[stream-type.5] unwraps (sync) Generator<T, TReturn, TNext> to T', () => {
    expect(detectStreamElementType('Generator<Chunk, void, unknown>')).toBe(
      'Chunk'
    );
  });

  it('[stream-type.6] unwraps (sync) Iterable<T> to T', () => {
    expect(detectStreamElementType('Iterable<Chunk>')).toBe('Chunk');
  });

  it('[stream-type.7] unwraps (sync) IterableIterator<T> to T', () => {
    expect(detectStreamElementType('IterableIterator<Chunk>')).toBe('Chunk');
  });

  it('[stream-type.8] unwraps the project-specific ApiStream<T> alias to T', () => {
    expect(detectStreamElementType('ApiStream<Chunk>')).toBe('Chunk');
  });

  it('[stream-type.9] recognizes an import-qualified wrapper name (cross-module type alias)', () => {
    expect(
      detectStreamElementType(
        'import("/abs/path/stream").ApiStream<{ x: number }>'
      )
    ).toBe('{ x: number }');
  });

  it('[stream-type.10] handles a nested-generic element type without mis-splitting on its internal commas', () => {
    expect(
      detectStreamElementType('AsyncGenerator<Map<string, number>, void, unknown>')
    ).toBe('Map<string, number>');
  });

  it('[stream-type.11] handles an inline object-literal element type', () => {
    expect(detectStreamElementType('AsyncGenerator<{ a: number; b: string }>')).toBe(
      '{ a: number; b: string }'
    );
  });

  it('[stream-type.NEGATIVE.1] returns null for a plain Promise<T> (not a stream wrapper)', () => {
    expect(detectStreamElementType('Promise<{ value: string }>')).toBeNull();
  });

  it('[stream-type.NEGATIVE.2] returns null for a bare scalar/object return type', () => {
    expect(detectStreamElementType('{ id: string; name: string }')).toBeNull();
    expect(detectStreamElementType('string')).toBeNull();
    expect(detectStreamElementType('void')).toBeNull();
  });

  it('[stream-type.NEGATIVE.3] returns null for a union with a stream member (AsyncGenerator<T> | null) — the outer `<...>` closes before the end of the string', () => {
    expect(
      detectStreamElementType('AsyncGenerator<Chunk, void, unknown> | null')
    ).toBeNull();
  });

  it('[stream-type.NEGATIVE.4] returns null for an unrelated generic type sharing no recognized wrapper name', () => {
    expect(detectStreamElementType('Array<Chunk>')).toBeNull();
    expect(detectStreamElementType('ReadonlyArray<Chunk>')).toBeNull();
  });

  it('[stream-type.NEGATIVE.5] returns null for an empty/whitespace string', () => {
    expect(detectStreamElementType('')).toBeNull();
    expect(detectStreamElementType('   ')).toBeNull();
  });
});
