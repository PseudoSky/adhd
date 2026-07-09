import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeFieldDefinitions } from '../field-merge';
import { coerceConfig, coerceValue, inferEnvVar, readStore, resolveConfig, unflatten } from '../config-resolver';

describe('inferEnvVar', () => {
  it('matches the contract test vector', () => {
    expect(inferEnvVar('ADHD_AGENT_MCP', 'db.path')).toBe('ADHD_AGENT_MCP_DB_PATH');
  });

  it('replaces both dots and dashes with underscores', () => {
    expect(inferEnvVar('ADHD_AGENT_MCP', 'provider-key.secret')).toBe('ADHD_AGENT_MCP_PROVIDER_KEY_SECRET');
  });
});

describe('readStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhd-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when the store file does not exist', () => {
    expect(readStore(dir, 'adhd', 'my-project', 'default')).toEqual({});
  });

  it('returns {} when the store file is corrupt JSON', () => {
    const storeDir = join(dir, 'adhd', 'my-project', 'default');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, '.adhd-store.json'), '{not json', 'utf8');
    expect(readStore(dir, 'adhd', 'my-project', 'default')).toEqual({});
  });

  it('reads declared values from a well-formed store file', () => {
    const storeDir = join(dir, 'adhd', 'my-project', 'default');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(storeDir, '.adhd-store.json'),
      JSON.stringify({ version: '0.0.5', values: { 'providers.openai.secret': 'sk-test' }, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    expect(readStore(dir, 'adhd', 'my-project', 'default')).toEqual({ 'providers.openai.secret': 'sk-test' });
    expect(existsSync(join(storeDir, '.adhd-store.json'))).toBe(true);
  });
});

describe('resolveConfig', () => {
  it('uses the env var when present (inferred name)', () => {
    const fields = mergeFieldDefinitions({}, {}, { 'db.path': { type: 'string', default: '/default/db' } });
    const { raw, resolved } = resolveConfig(fields, {
      prefix: 'ADHD_TEST',
      processEnv: { ADHD_TEST_DB_PATH: '/env/db' },
    });
    expect(raw['db.path']).toBe('/env/db');
    expect(resolved['db.path']).toEqual({ value: '/env/db', source: 'project.env', scope: 'project', env: 'ADHD_TEST_DB_PATH' });
  });

  it('falls back to the store when the env var is absent', () => {
    const fields = mergeFieldDefinitions({}, {}, { 'db.path': { type: 'string', default: '/default/db' } });
    const { raw, resolved } = resolveConfig(fields, {
      prefix: 'ADHD_TEST',
      store: { 'db.path': '/store/db' },
      processEnv: {},
    });
    expect(raw['db.path']).toBe('/store/db');
    expect(resolved['db.path'].source).toBe('project.set');
  });

  it('falls back to the default when neither env nor store has a value', () => {
    const fields = mergeFieldDefinitions({}, {}, { 'db.path': { type: 'string', default: '/default/db' } });
    const { raw, resolved } = resolveConfig(fields, { prefix: 'ADHD_TEST', processEnv: {} });
    expect(raw['db.path']).toBe('/default/db');
    expect(resolved['db.path'].source).toBe('project.default');
  });

  it('respects noEnv — suppresses env lookup even when the var is set', () => {
    const fields = mergeFieldDefinitions(
      {},
      {},
      { 'db.path': { type: 'string', default: '/default/db', noEnv: true } },
    );
    const { raw, resolved } = resolveConfig(fields, {
      prefix: 'ADHD_TEST',
      store: { 'db.path': '/store/db' },
      processEnv: { ADHD_TEST_DB_PATH: '/env/db' },
    });
    expect(raw['db.path']).toBe('/store/db');
    expect(resolved['db.path'].source).toBe('project.set');
  });

  it('uses an explicit env override name instead of the inferred name, with "project.override" provenance', () => {
    const fields = mergeFieldDefinitions(
      {},
      {},
      { 'providers.openai.secret': { type: 'string', default: '', env: 'OPENAI_API_KEY' } },
    );
    const { raw, resolved } = resolveConfig(fields, {
      prefix: 'ADHD_AGENT_MCP',
      processEnv: { OPENAI_API_KEY: 'sk-test', ADHD_AGENT_MCP_PROVIDERS_OPENAI_SECRET: 'should-not-be-used' },
    });
    expect(raw['providers.openai.secret']).toBe('sk-test');
    expect(resolved['providers.openai.secret']).toEqual({
      value: 'sk-test',
      source: 'project.override',
      scope: 'project',
      env: 'OPENAI_API_KEY',
    });
  });

  it('resolves system-scope fields from default only, ignoring env and store', () => {
    const fields = mergeFieldDefinitions({ 'log.level': { type: 'string', default: 'info' } }, {}, {});
    const { raw, resolved } = resolveConfig(fields, {
      prefix: 'ADHD_TEST',
      store: { 'log.level': 'from-store' },
      processEnv: { ADHD_TEST_LOG_LEVEL: 'from-env' },
    });
    expect(raw['log.level']).toBe('info');
    expect(resolved['log.level'].source).toBe('system.default');
  });

  it('resolves global-scope fields from env or default, never from the store', () => {
    const fields = mergeFieldDefinitions({}, { 'transport.kind': { type: 'string', default: 'stdio' } }, {});
    const withEnv = resolveConfig(fields, { prefix: 'ADHD_TEST', processEnv: { ADHD_TEST_TRANSPORT_KIND: 'sse' } });
    expect(withEnv.resolved['transport.kind'].source).toBe('global.env');

    const withoutEnv = resolveConfig(fields, {
      prefix: 'ADHD_TEST',
      store: { 'transport.kind': 'from-store' },
      processEnv: {},
    });
    expect(withoutEnv.raw['transport.kind']).toBe('stdio');
    expect(withoutEnv.resolved['transport.kind'].source).toBe('global.default');
  });

  it('filters by scope when options.scope is provided', () => {
    const fields = mergeFieldDefinitions(
      { 'log.level': { type: 'string', default: 'info' } },
      { 'transport.kind': { type: 'string', default: 'stdio' } },
      { 'db.path': { type: 'string', default: '/tmp/db' } },
    );
    const { raw } = resolveConfig(fields, { prefix: 'ADHD_TEST', scope: 'project', processEnv: {} });
    expect(Object.keys(raw)).toEqual(['db.path']);
  });

  it('finalizes the env sentinel on the returned fields map', () => {
    const fields = mergeFieldDefinitions({}, {}, { 'db.path': { type: 'string', default: '/tmp/db' } });
    expect(fields['db.path'].env).toBe('');
    const { fields: resolvedFields } = resolveConfig(fields, { prefix: 'ADHD_TEST', processEnv: {} });
    expect(resolvedFields['db.path'].env).toBe('ADHD_TEST_DB_PATH');
    // Input map must not be mutated (pure function).
    expect(fields['db.path'].env).toBe('');
  });
});

describe('interpolateValue', () => {
  it('interpolates a single ${VAR} reference', async () => {
    const { interpolateValue } = await import('../config-resolver');
    expect(interpolateValue('${HOME}/data', { HOME: '/Users/nix' })).toBe('/Users/nix/data');
  });

  it('leaves an unresolved ${VAR} reference as a literal', async () => {
    const { interpolateValue } = await import('../config-resolver');
    expect(interpolateValue('${MISSING}', {})).toBe('${MISSING}');
  });

  it('interpolates multiple references in one string', async () => {
    const { interpolateValue } = await import('../config-resolver');
    expect(interpolateValue('${VAR1}_${VAR2}', { VAR1: 'a', VAR2: 'b' })).toBe('a_b');
  });

  it('passes non-string values through unchanged', async () => {
    const { interpolateValue } = await import('../config-resolver');
    expect(interpolateValue(42, {})).toBe(42);
    expect(interpolateValue(true, {})).toBe(true);
    expect(interpolateValue(null, {})).toBe(null);
    expect(interpolateValue(undefined, {})).toBe(undefined);
  });

  it('is single-level only — does not recursively expand the substituted value', async () => {
    const { interpolateValue } = await import('../config-resolver');
    expect(interpolateValue('${OUTER}', { OUTER: '${INNER}', INNER: 'resolved' })).toBe('${INNER}');
  });
});

describe('unflatten', () => {
  it('converts flat dot-path keys into nested objects', () => {
    expect(unflatten({ 'db.path': '/tmp/db', 'server.port': '3000' })).toEqual({
      db: { path: '/tmp/db' },
      server: { port: '3000' },
    });
  });

  it('merges multiple keys under the same parent', () => {
    expect(unflatten({ 'providers.openai.secret': 'x', 'providers.openai.model': 'gpt-4o' })).toEqual({
      providers: { openai: { secret: 'x', model: 'gpt-4o' } },
    });
  });

  it('handles a single top-level key with no dots', () => {
    expect(unflatten({ name: 'my-project' })).toEqual({ name: 'my-project' });
  });

  it('handles an empty input', () => {
    expect(unflatten({})).toEqual({});
  });
});

describe('coerceValue', () => {
  it('coerces "integer" strings to numbers', () => {
    expect(coerceValue('3000', 'integer')).toBe(3000);
  });

  it('coerces "number" strings to floats', () => {
    expect(coerceValue('3.14', 'number')).toBe(3.14);
  });

  it('coerces "boolean" strings case-insensitively', () => {
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('False', 'boolean')).toBe(false);
  });

  it('coerces "array" comma-separated strings to arrays', () => {
    expect(coerceValue('a,b, c', 'array')).toEqual(['a', 'b', 'c']);
    expect(coerceValue('', 'array')).toEqual([]);
  });

  it('passes strings through for "string" type, stringifying non-strings', () => {
    expect(coerceValue('hello', 'string')).toBe('hello');
    expect(coerceValue(42, 'string')).toBe('42');
  });

  it('leaves an unparsable "integer" value unchanged rather than producing NaN', () => {
    expect(coerceValue('not-a-number', 'integer')).toBe('not-a-number');
  });

  it('passes undefined through unchanged', () => {
    expect(coerceValue(undefined, 'integer')).toBe(undefined);
  });
});

describe('coerceConfig', () => {
  it('coerces every flat field according to its declared type', () => {
    const fields = mergeFieldDefinitions(
      {},
      {},
      {
        'server.port': { type: 'integer', default: '3000' },
        'server.enabled': { type: 'boolean', default: 'true' },
      },
    );
    const result = coerceConfig({ 'server.port': '3000', 'server.enabled': 'true' }, fields);
    expect(result).toEqual({ 'server.port': 3000, 'server.enabled': true });
  });

  it('passes through raw values for keys with no matching field definition', () => {
    const result = coerceConfig({ 'unknown.key': 'literal' }, {});
    expect(result).toEqual({ 'unknown.key': 'literal' });
  });
});
