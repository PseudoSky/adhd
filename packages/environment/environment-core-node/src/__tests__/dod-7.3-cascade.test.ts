/**
 * DoD §7.3 — Cascade proof (ARCHITECTURE.md).
 *
 * Write a project-scope `config.yaml` → it overrides the default; set the
 * remapped env var → it overrides the file. Each layer proven by a distinct
 * assertion.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '../environment';
import { cleanupFixtures, mkAdhdRoot, mkCwdFixture, withEnvVar } from '../test/fixtures';

type Cfg = { a: { port: number } };

afterEach(() => {
  cleanupFixtures();
});

describe('DoD §7.3 — cascade: default → project file → env var', () => {
  it('layer 1 (spec default) applies with nothing else present', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const env = new Environment<Cfg>('t', { config: { 'a.port': { type: 'integer', default: 8787 } } }, {
      scope: 'global',
      adhdRoot,
      cwd,
    });
    expect(env.config.a.port).toBe(8787);
    expect(env.get('provenance.a.port').source).toBe('default');
  });

  it('layer 2: a project-scope config.yaml OVERRIDES the spec default', () => {
    const projectRoot = mkCwdFixture(); // this IS the cwd AND the project root (marker: .adhd dir we write into)
    const adhdRoot = mkAdhdRoot();
    const layerDir = join(projectRoot, '.adhd', 't', 'default');
    mkdirSync(layerDir, { recursive: true });
    writeFileSync(join(layerDir, 'config.yaml'), 'a:\n  port: 9000\n', 'utf8');

    const env = new Environment<Cfg>('t', { config: { 'a.port': { type: 'integer', default: 8787 } } }, {
      scope: 'project',
      cwd: projectRoot,
      adhdRoot,
    });

    expect(env.config.a.port).toBe(9000);
    expect(env.get('provenance.a.port').source).toBe('project');
  });

  it('layer 3: the remapped env var OVERRIDES the project file (highest precedence)', () => {
    const projectRoot = mkCwdFixture();
    const adhdRoot = mkAdhdRoot();
    const layerDir = join(projectRoot, '.adhd', 't', 'default');
    mkdirSync(layerDir, { recursive: true });
    writeFileSync(join(layerDir, 'config.yaml'), 'a:\n  port: 9000\n', 'utf8');

    const restore = withEnvVar('ADHD_T_A_PORT', '9999');
    try {
      const env = new Environment<Cfg>('t', { config: { 'a.port': { type: 'integer', default: 8787 } } }, {
        scope: 'project',
        cwd: projectRoot,
        adhdRoot,
      });
      expect(env.config.a.port).toBe(9999);
      expect(env.get('provenance.a.port')).toEqual({ source: 'env', scope: 'project', env: 'ADHD_T_A_PORT' });
    } finally {
      restore();
    }
  });

  it('local file (config.local.yaml) overrides the project file', () => {
    const projectRoot = mkCwdFixture();
    const adhdRoot = mkAdhdRoot();
    const layerDir = join(projectRoot, '.adhd', 't', 'default');
    mkdirSync(layerDir, { recursive: true });
    writeFileSync(join(layerDir, 'config.yaml'), 'a:\n  port: 9000\n', 'utf8');
    writeFileSync(join(layerDir, 'config.local.yaml'), 'a:\n  port: 9500\n', 'utf8');

    const env = new Environment<Cfg>('t', { config: { 'a.port': { type: 'integer', default: 8787 } } }, {
      scope: 'project',
      cwd: projectRoot,
      adhdRoot,
    });
    expect(env.config.a.port).toBe(9500);
    expect(env.get('provenance.a.port').source).toBe('local');
  });
});
