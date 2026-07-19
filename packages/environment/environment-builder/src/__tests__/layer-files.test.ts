import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { flattenToPaths, loadLayerFiles, readLayerFile } from '../layer-files';

const cleanupDirs: string[] = [];
function mkFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-env-layerfiles-'));
  cleanupDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('flattenToPaths', () => {
  it('flattens nested objects to dot-path keys', () => {
    expect(flattenToPaths({ a: { port: 9000 }, b: 'x' })).toEqual({ 'a.port': 9000, b: 'x' });
  });

  it('treats arrays as terminal (non-descended) values', () => {
    expect(flattenToPaths({ a: { list: [1, 2, 3] } })).toEqual({ 'a.list': [1, 2, 3] });
  });

  it('handles deep nesting', () => {
    expect(flattenToPaths({ a: { b: { c: 'deep' } } })).toEqual({ 'a.b.c': 'deep' });
  });
});

describe('readLayerFile', () => {
  it('returns undefined for a missing file (no error) — every layer is optional', () => {
    const dir = mkFixtureDir();
    expect(readLayerFile(join(dir, 'config.yaml'))).toBeUndefined();
  });

  it('returns undefined for malformed YAML rather than throwing', () => {
    const dir = mkFixtureDir();
    const filePath = join(dir, 'config.yaml');
    writeFileSync(filePath, '{ this is: not: valid: yaml: [', 'utf8');
    expect(readLayerFile(filePath)).toBeUndefined();
  });

  it('returns undefined for a YAML scalar (not a mapping)', () => {
    const dir = mkFixtureDir();
    const filePath = join(dir, 'config.yaml');
    writeFileSync(filePath, 'just-a-string\n', 'utf8');
    expect(readLayerFile(filePath)).toBeUndefined();
  });

  it('parses a nested YAML mapping into a flat dot-path map', () => {
    const dir = mkFixtureDir();
    const filePath = join(dir, 'config.yaml');
    writeFileSync(filePath, 'a:\n  port: 9000\nb: hello\n', 'utf8');
    expect(readLayerFile(filePath)).toEqual({ 'a.port': 9000, b: 'hello' });
  });
});

describe('loadLayerFiles', () => {
  it('every layer is undefined when no root has a config file (zero-config)', () => {
    const system = mkFixtureDir();
    const global = mkFixtureDir();
    const layers = loadLayerFiles({ system, global });
    expect(layers).toEqual({ system: undefined, global: undefined, project: undefined, local: undefined });
  });

  it('reads system/global/project config.yaml independently, and project config.local.yaml', () => {
    const system = mkFixtureDir();
    const global = mkFixtureDir();
    const project = mkFixtureDir();
    writeFileSync(join(system, 'config.yaml'), 'a: { port: 1 }\n', 'utf8');
    writeFileSync(join(global, 'config.yaml'), 'a: { port: 2 }\n', 'utf8');
    writeFileSync(join(project, 'config.yaml'), 'a: { port: 3 }\n', 'utf8');
    writeFileSync(join(project, 'config.local.yaml'), 'a: { port: 4 }\n', 'utf8');

    const layers = loadLayerFiles({ system, global, project });
    expect(layers.system).toEqual({ 'a.port': 1 });
    expect(layers.global).toEqual({ 'a.port': 2 });
    expect(layers.project).toEqual({ 'a.port': 3 });
    expect(layers.local).toEqual({ 'a.port': 4 });
  });

  it('local is never read from system/global roots — only from the project root', () => {
    const system = mkFixtureDir();
    const global = mkFixtureDir();
    // No `project` root at all — local must stay undefined, never fall back to system/global.
    mkdirSync(join(system, 'ignored'), { recursive: true });
    const layers = loadLayerFiles({ system, global });
    expect(layers.local).toBeUndefined();
  });
});
