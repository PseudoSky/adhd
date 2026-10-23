/**
 * This file is the 0945d1b9 AC3 test (the spec names it `global-layer-applied.spec.ts`; `.test.ts` matches its neighbours).
 *
 * guards: the GLOBAL config layer (`$HOME/.adhd/<project>/<namespace>/config.yaml`) really reaches the resolved
 *   config, and an absent global file resolves silently to the default. This is the premise of the spawn-isolation
 *   posture: a child process that inherits the real HOME reads the machine's real global layer, so spawned test
 *   processes must redirect HOME (backlog 0945d1b9 D1). If the global layer were ignored the leak would not exist and
 *   the HOME redirect would be unnecessary; this test pins that it is not ignored.
 * tier: S (real filesystem in a throwaway HOME under tmp/, real loadLayerFiles + resolveConfig + buildSnapshot; no
 *   process is spawned and nothing sleeps)
 * cites: 0945d1b9 AC3 (global layer applied by config-resolver; absent global file resolves silently), supporting AC1
 *   (why spawned processes must redirect HOME).
 * red: pending - the owner's hold forbids running tests. The cascade already implements this (config-resolver.ts
 *   FILE_LAYER_ORDER, layer-files.ts loadLayerFiles), so this is a characterization of existing behavior and passes
 *   against the current tree; a deliberate break (dropping `global` from FILE_LAYER_ORDER, or reading the global root
 *   from somewhere other than os.homedir()) fails the cases below with `expected 8787 to be 9100`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentSpec } from '@adhd/environment-base-spec';
import { DEFAULT_NAMESPACE, DEFAULT_ORG_NAMESPACE } from '@adhd/environment-base-spec';
import { resolveConfig } from '../../src/config-resolver';
import { loadLayerFiles } from '../../src/layer-files';
import { resolveRoots } from '../../src/roots';
import { buildSnapshot } from '../../src/snapshot';

type Cfg = { a: { port: number } };

const PROJECT = 'global-layer-probe';
// Anchored to this file (not process.cwd()), so running vitest from the package dir cannot land the scratch in an
// untracked packages/.../tmp. Removal is bounded to this root (user decision 2026-10-15: tests may rmSync a computed
// path only when it is under tmp/<package>/ and a guard throws on escape).
const SCRATCH_PARENT = resolve(__dirname, '../../../../../tmp/environment-builder-global-layer');
const cleanupDirs: string[] = [];

/** A throwaway HOME under tmp/ (gitignored), removed in afterEach. */
function mkHome(): string {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_PARENT, 'home-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Where the global layer file lives for `home`: `<home>/.adhd/<project>/<namespace>/config.yaml`. */
function globalConfigPath(home: string): string {
  return join(home, `.${DEFAULT_ORG_NAMESPACE}`, PROJECT, DEFAULT_NAMESPACE, 'config.yaml');
}

function writeGlobalConfig(home: string, yaml: string): void {
  const file = globalConfigPath(home);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, yaml, 'utf8');
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (!dir) continue;
    if (!resolve(dir).startsWith(SCRATCH_PARENT + sep)) throw new Error(`refusing to remove ${dir}: outside ${SCRATCH_PARENT}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

const SPEC: EnvironmentSpec<Cfg> = { config: { 'a.port': { type: 'integer', default: 8787 } } };

describe('the global layer file is applied (0945d1b9 AC3)', () => {
  it('loadLayerFiles reads the global layer from $HOME/.adhd/<project>/<namespace>/config.yaml', () => {
    const home = mkHome();
    writeGlobalConfig(home, 'a:\n  port: 9100\n');
    vi.stubEnv('HOME', home);
    const roots = resolveRoots({ project: PROJECT, namespace: DEFAULT_NAMESPACE, orgNamespace: DEFAULT_ORG_NAMESPACE });
    expect(roots.global).toBe(join(home, `.${DEFAULT_ORG_NAMESPACE}`, PROJECT, DEFAULT_NAMESPACE));
    expect(loadLayerFiles(roots).global).toEqual({ 'a.port': 9100 });
  });

  it('resolveConfig applies a value in the global layer over the field default, with global provenance', () => {
    const layers = { system: undefined, global: { 'a.port': 9100 }, project: undefined, local: undefined };
    const { nested, provenance } = resolveConfig(SPEC.config, layers, {}, { prefix: 'ADHD_T', activeScope: 'global' });
    expect((nested['a'] as { port: number }).port).toBe(9100);
    expect(provenance['a.port'].source).toBe('global');
  });

  it('end to end: buildSnapshot with only HOME redirected returns the value written to that HOME global layer', () => {
    const home = mkHome();
    writeGlobalConfig(home, 'a:\n  port: 9100\n');
    vi.stubEnv('HOME', home);
    const snap = buildSnapshot<Cfg>(PROJECT, SPEC, { scope: 'global', processEnv: {} });
    expect(snap.config.a.port).toBe(9100);
    expect(snap.provenance['a.port'].source).toBe('global');
  });

  it('negative control: an empty HOME resolves the default, so the value above came from the HOME-derived global file', () => {
    const withFile = mkHome();
    writeGlobalConfig(withFile, 'a:\n  port: 9100\n');
    const empty = mkHome();

    vi.stubEnv('HOME', withFile);
    expect(buildSnapshot<Cfg>(PROJECT, SPEC, { scope: 'global', processEnv: {} }).config.a.port).toBe(9100);

    vi.stubEnv('HOME', empty);
    const snap = buildSnapshot<Cfg>(PROJECT, SPEC, { scope: 'global', processEnv: {} });
    expect(snap.config.a.port).toBe(8787);
    expect(snap.provenance['a.port'].source).toBe('default');
  });

  it('an absent global file resolves silently: no throw, an undefined global layer, and the default applies', () => {
    const home = mkHome();
    vi.stubEnv('HOME', home);
    // the system root reads XDG_DATA_HOME / APPDATA from the ambient env (roots.ts systemAppDir), which a HOME stub does
    // not redirect: point them at an empty throwaway dir so a developer's real system layer cannot leak in
    const emptyAppData = mkHome();
    vi.stubEnv('XDG_DATA_HOME', emptyAppData);
    vi.stubEnv('XDG_CONFIG_HOME', emptyAppData);
    vi.stubEnv('APPDATA', emptyAppData);
    const roots = resolveRoots({ project: PROJECT, namespace: DEFAULT_NAMESPACE, orgNamespace: DEFAULT_ORG_NAMESPACE });
    expect(() => loadLayerFiles(roots)).not.toThrow();
    expect(loadLayerFiles(roots).global).toBeUndefined();
    const snap = buildSnapshot<Cfg>(PROJECT, SPEC, { scope: 'global', processEnv: {} });
    expect(snap.config.a.port).toBe(8787);
    expect(snap.provenance['a.port'].source).toBe('default');
  });

  it('an explicit env var still outranks the global layer (the global layer is not the top of the cascade)', () => {
    const home = mkHome();
    writeGlobalConfig(home, 'a:\n  port: 9100\n');
    vi.stubEnv('HOME', home);
    const snap = buildSnapshot<Cfg>(PROJECT, SPEC, {
      scope: 'global',
      processEnv: { [`ADHD_GLOBAL_LAYER_PROBE_A_PORT`]: '9200' },
    });
    expect(snap.config.a.port).toBe(9200);
    expect(snap.provenance['a.port'].source).toBe('env');
  });
});
