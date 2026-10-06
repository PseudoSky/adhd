/**
 * NAT-TOOL-7 — the canonical native-tooling `FieldSpec` fragment that
 * `environment-base-spec` contributes (ADR-0008 D10).
 *
 * Ticket: 20006dff-bba3-4415-90a4-636fc2d2f9a7
 * AC2 (binary): `npx nx lint environment-base-spec` exits 0.
 *   The lint gate itself is the authoritative proof (run in the task report);
 *   this suite is the fast, default-running regression guard for the shape the
 *   gate protects — the fragment must stay a legal, namespaced `FieldSpec`
 *   record. (Source-level greps over the two changed files live in agent-mcp's
 *   `native-tooling-config.test.ts`, whose spec tsconfig is ESM.)
 */
import { describe, expect, it } from 'vitest';

import { nativeToolingConfigFieldSpecs, type FieldType } from '../index';

const LEGAL_TYPES: readonly FieldType[] = ['string', 'integer', 'number', 'boolean', 'array'];
const FRAGMENT = nativeToolingConfigFieldSpecs('ADHD_AGENT');

describe('NAT-TOOL-7 AC2 — environment-base-spec native tooling field-spec fragment', () => {
  it('AC2: the fragment builder is exported, every key is namespaced under `nativeTooling.`, and every leaf has a legal FieldType', () => {
    const keys = Object.keys(FRAGMENT);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith('nativeTooling.')).toBe(true);
      expect(LEGAL_TYPES).toContain(FRAGMENT[key].type);
    }
  });

  it('AC2: the fragment covers every member ADR-0008 D10 requires (fs.*, shell.*, dispatch.*, hitl)', () => {
    const keys = Object.keys(FRAGMENT);
    expect(keys.some((k) => k.startsWith('nativeTooling.fs.'))).toBe(true);
    expect(keys.some((k) => k.startsWith('nativeTooling.shell.'))).toBe(true);
    expect(keys.some((k) => k.startsWith('nativeTooling.dispatch.'))).toBe(true);
    expect(keys).toContain('nativeTooling.hitl');
  });

  it('AC2: every leaf declares an explicit `<prefix>_NATIVE_TOOLING_<LEAF>` env name (inference would collapse camelCase)', () => {
    for (const [key, spec] of Object.entries(FRAGMENT)) {
      expect(spec.env, key).toMatch(/^ADHD_AGENT_NATIVE_TOOLING_[A-Z0-9_]+$/);
    }
  });

  it('NAT-TOOL-7: retired surfaces are absent from the fragment (retired ask-policy knobs / retention)', () => {
    const keys = Object.keys(FRAGMENT);
    expect(keys.some((k) => /askpolicy/i.test(k))).toBe(false);
    // no retention field — retention is a session/run surface (ADR-0008 D6)
    expect(keys.some((k) => /retention|ttlMs/.test(k))).toBe(false);
    // `hitl` carries the ADR default (true); roots carry NO default (task-time, D4)
    expect(FRAGMENT['nativeTooling.hitl'].default).toBe(true);
    expect(FRAGMENT['nativeTooling.fs.root'].default).toBeUndefined();
    expect(FRAGMENT['nativeTooling.shell.root'].default).toBeUndefined();
  });

  it('B2: the retired `nativeTooling.shell.denyCommands` is absent from the fragment', () => {
    // Removed surface (ADR-0008 D5: the adopted shell server is allow-list only;
    // a deny-list would be a silent no-op). Re-adding the FieldSpec turns this RED.
    expect(Object.keys(FRAGMENT)).not.toContain('nativeTooling.shell.denyCommands');
    expect(
      Object.values(FRAGMENT).some((f) => /SHELL_DENY_COMMANDS/.test(String(f.env)))
    ).toBe(false);
  });
});
