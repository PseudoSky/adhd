/**
 * b3999dfa AC1: the README's spend-overshoot bound is scoped to the path it is true for.
 *
 * `toolCallConcurrency - 1` comes from the orchestrator's native tool pool; the claudecli bridge path is not
 * pooled. The README must say so, and must document the reservation over-refusal.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const readme = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');

describe('b3999dfa AC1: README concurrency claims', () => {
  it('b3999dfa AC1: the toolCallConcurrency - 1 bound is scoped to the native tool loop and the claudecli bridge path is described', () => {
    expect(readme).toContain('native tool-loop property only');
    expect(readme).toMatch(/`claudecli` provider does not use that pool/);
    expect(readme).toMatch(/not by `toolCallConcurrency`/);
  });

  it('b3999dfa AC1: the reservation over-refusal is documented as conservative', () => {
    expect(readme).toContain('can over-refuse a concurrent one');
    expect(readme).toMatch(/never "allow too much"/);
  });
});
