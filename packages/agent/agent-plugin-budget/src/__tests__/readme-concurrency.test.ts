/**
 * b3999dfa AC1: the README's spend-overshoot bound is stated for the paths it is true for.
 *
 * `toolCallConcurrency - 1` comes from the orchestrator's per-task limiter, which since provider-parity (plan
 * ce473fa3) both the native tool loop and the claudecli loopback bridge acquire. The README must say so (the earlier
 * "native tool-loop property only" wording is retired), name the residual (CLI built-ins run outside the pool), and
 * document the reservation over-refusal.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const readme = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'), 'utf8');

describe('b3999dfa AC1: README concurrency claims', () => {
  it('b3999dfa AC1: the toolCallConcurrency - 1 bound is scoped to the native tool loop and the claudecli bridge path is described', () => {
    expect(readme).not.toContain('native tool-loop property only');
    expect(readme).toMatch(/bound holds on every provider/);
    expect(readme).toMatch(/`claudecli` loopback MCP bridge/);
    expect(readme).toMatch(/provider:builtin_bypass/);
  });

  it('b3999dfa AC1: the reservation over-refusal is documented as conservative', () => {
    expect(readme).toContain('can over-refuse a concurrent one');
    expect(readme).toMatch(/never "allow too much"/);
  });
});
