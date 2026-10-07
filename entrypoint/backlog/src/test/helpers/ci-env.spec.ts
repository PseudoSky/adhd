/**
 * ci-env.spec.ts — 55ba4178 B-AC11: the CI detector the skip-hardening in
 * `server.tracing-required.spec.ts` relies on.
 */
import { describe, expect, it } from 'vitest';
import { isCiRun } from './ci-env.js';

describe('55ba4178 B-AC11 isCiRun', () => {
  it('55ba4178 B-AC11 true for the values CI providers set', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'github']) expect(isCiRun({ CI: v })).toBe(true);
  });
  it('55ba4178 B-AC11 false when unset, empty, or explicitly off', () => {
    for (const v of [undefined, '', 'false', 'FALSE', '0']) expect(isCiRun({ CI: v })).toBe(false);
    expect(isCiRun({})).toBe(false);
  });
});
