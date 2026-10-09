import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPENROUTER_SNAPSHOT } from '../pricing/pricing-snapshot.js';

/**
 * 37f6c511 — pricing.json is the single committed source of the OpenRouter data;
 * pricing-snapshot.ts is its generated TS projection (scripts/gen-pricing-snapshot.mjs).
 * Editing one without regenerating the other must fail here, by default, in the unit lane.
 */
describe('37f6c511 pricing.json <-> pricing-snapshot.ts drift', () => {
  it('the generated TS module deep-equals pricing.json', () => {
    const json = JSON.parse(
      readFileSync(fileURLToPath(new URL('../pricing/pricing.json', import.meta.url)), 'utf8')
    ) as unknown;
    expect(OPENROUTER_SNAPSHOT).toEqual(json);
  });

  it('has a non-trivial model list (guards against an emptied snapshot)', () => {
    expect(OPENROUTER_SNAPSHOT.models.length).toBeGreaterThan(100);
    expect(OPENROUTER_SNAPSHOT.model_count).toBe(OPENROUTER_SNAPSHOT.models.length);
  });
});
