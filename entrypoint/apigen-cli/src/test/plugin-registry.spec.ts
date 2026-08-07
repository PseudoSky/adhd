import { describe, it, expect } from 'vitest';
import type { OutputPlugin } from '@adhd/apigen-core-client';
import cliOutputPlugin from '@adhd/apigen-plugin-cli-output';
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema';
import {
  pluginTypeIds,
  runCapableTypeIds,
  generateOnlyTypeIds,
  describeTypeOption,
  describeRunTypeOption,
  unknownTypeError,
  unsupportedRunError,
  formatTypesList,
} from '../lib/plugin-registry';

// ───────────────────────────────────────────────────────────────────────────
// FEAT-APIGEN-019 — every one of these helpers reads the live `plugins` map
// (not a hand-maintained string), so a fixture registry that differs from
// the real CLI's is enough to prove derivation rather than hardcoding.
// ───────────────────────────────────────────────────────────────────────────

function makePlugin(id: string, opts: { run?: boolean } = {}): OutputPlugin {
  return {
    id,
    description: `${id} description`,
    generate: () => ({ files: [] }),
    ...(opts.run ? { run: async () => undefined } : {}),
  };
}

const genOnly = makePlugin('gen-only');
const runCapable = makePlugin('run-capable', { run: true });

const twoPluginRegistry: Record<string, OutputPlugin> = {
  'gen-only': genOnly,
  'run-capable': runCapable,
};

describe('pluginTypeIds', () => {
  it('returns every registered key, including aliases pointing at the same plugin object', () => {
    const shared = makePlugin('shared');
    const registry: Record<string, OutputPlugin> = {
      shared,
      'shared-alias': shared,
    };
    expect(pluginTypeIds(registry)).toEqual(['shared', 'shared-alias']);
  });

  it('reflects a smaller/larger registry — proves derivation, not a fixed list', () => {
    expect(pluginTypeIds({ solo: genOnly })).toEqual(['solo']);
    expect(pluginTypeIds(twoPluginRegistry)).toEqual(['gen-only', 'run-capable']);
  });
});

describe('runCapableTypeIds / generateOnlyTypeIds', () => {
  it('partitions the registry by presence of plugin.run', () => {
    expect(runCapableTypeIds(twoPluginRegistry)).toEqual(['run-capable']);
    expect(generateOnlyTypeIds(twoPluginRegistry)).toEqual(['gen-only']);
  });

  it('changes when a plugin gains/loses a run() method (same id, different object)', () => {
    const registryBefore: Record<string, OutputPlugin> = { x: makePlugin('x') };
    const registryAfter: Record<string, OutputPlugin> = {
      x: makePlugin('x', { run: true }),
    };
    expect(runCapableTypeIds(registryBefore)).toEqual([]);
    expect(runCapableTypeIds(registryAfter)).toEqual(['x']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `cli` run-capability — proves the REAL `@adhd/apigen-plugin-cli-output`
// export (not a fixture) now satisfies `runCapableTypeIds`/`describeRunTypeOption`
// purely because it grew a `run()` method. This registry file has no
// per-plugin allowlist to edit — `runCapableTypeIds` derives from
// `typeof plugin.run === 'function'` — so `--type cli` accepting `apigen run`
// falls out of the CLI plugin gaining `run()`, with zero changes needed here.
// ───────────────────────────────────────────────────────────────────────────

describe('cli plugin run-capability (real @adhd/apigen-plugin-cli-output export)', () => {
  const realRegistry: Record<string, OutputPlugin> = {
    cli: cliOutputPlugin,
    jsonschema: jsonschemaPlugin,
  };

  it('cli is now run-capable — apigen run --type cli is accepted', () => {
    expect(runCapableTypeIds(realRegistry)).toContain('cli');
    expect(generateOnlyTypeIds(realRegistry)).not.toContain('cli');
  });

  it('jsonschema (a real generate-only plugin) stays generate-only for contrast', () => {
    expect(generateOnlyTypeIds(realRegistry)).toContain('jsonschema');
    expect(runCapableTypeIds(realRegistry)).not.toContain('jsonschema');
  });

  it('describeRunTypeOption / unsupportedRunError reflect cli as run-capable', () => {
    expect(describeRunTypeOption(realRegistry)).toContain('cli');
    expect(() => {
      const plugin = realRegistry['cli'];
      if (!plugin.run) throw unsupportedRunError('cli', realRegistry);
    }).not.toThrow();
  });
});

describe('describeTypeOption (generate/generate-registry help text)', () => {
  it('lists every registered id, alphabetically, for the current registry', () => {
    expect(describeTypeOption(twoPluginRegistry)).toBe(
      'Output target — one of: gen-only | run-capable (see `apigen list-types`)'
    );
  });

  it('changes when a plugin is added to the registry — not a static string', () => {
    const before = describeTypeOption({ 'gen-only': genOnly });
    const after = describeTypeOption(twoPluginRegistry);
    expect(before).not.toContain('run-capable');
    expect(after).toContain('run-capable');
  });

  it('changes when a plugin is removed from the registry', () => {
    const full = describeTypeOption(twoPluginRegistry);
    const withoutRunCapable = describeTypeOption({ 'gen-only': genOnly });
    expect(full).toContain('run-capable');
    expect(withoutRunCapable).not.toContain('run-capable');
  });
});

describe('describeRunTypeOption (run/run-registry help text)', () => {
  it('only lists run-capable ids — generate-only plugins are excluded', () => {
    const text = describeRunTypeOption(twoPluginRegistry);
    expect(text).toContain('run-capable');
    expect(text).not.toContain('gen-only');
  });

  it('reflects a run-capable plugin newly added to the registry', () => {
    const before = describeRunTypeOption({ 'gen-only': genOnly });
    const after = describeRunTypeOption(twoPluginRegistry);
    expect(before).not.toContain('run-capable');
    expect(after).toContain('run-capable');
  });
});

describe('unknownTypeError', () => {
  it('names the bad --type and lists every registered id as Available', () => {
    const err = unknownTypeError('express', twoPluginRegistry);
    expect(err.message).toMatch(/Unknown --type: express/);
    expect(err.message).toContain('gen-only');
    expect(err.message).toContain('run-capable');
  });
});

describe('unsupportedRunError', () => {
  it('names the plugin, and lists generate-only + run-capable subsets separately', () => {
    const err = unsupportedRunError('gen-only', twoPluginRegistry);
    expect(err.message).toMatch(/Plugin gen-only does not support run mode/);
    expect(err.message).toMatch(/Generate-only plugins: gen-only/);
    expect(err.message).toMatch(/Run-capable plugins: run-capable/);
  });
});

describe('formatTypesList (`list-types` output)', () => {
  it('includes every id, its description, and its generate/run capability tag', () => {
    const text = formatTypesList(twoPluginRegistry);
    expect(text).toContain('gen-only');
    expect(text).toContain('gen-only description');
    expect(text).toMatch(/gen-only\s+\(generate\)/);
    expect(text).toContain('run-capable');
    expect(text).toContain('run-capable description');
    expect(text).toMatch(/run-capable\s+\(generate, run\)/);
  });

  it('reflects an added plugin — proves the list is derived, not a fixed table', () => {
    const before = formatTypesList({ 'gen-only': genOnly });
    const after = formatTypesList(twoPluginRegistry);
    expect(before).not.toContain('run-capable');
    expect(after).toContain('run-capable');
  });
});
