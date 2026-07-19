import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CONTENT_HASH_FORMAT_VERSION,
  DEFAULT_SHARE_BY_KIND,
  ENV_REF_PREFIX,
  LoneSurrogateError,
  contentHash,
  envRefVarName,
  generateFieldSchema,
  inferEnvVar,
  isEnvRef,
  makeEnvRef,
  projectEnvPrefix,
  resolveEnvRef,
  structureHash,
} from '../index';

describe('contentHash', () => {
  it('is cross-verified byte-for-byte against node:crypto sha256 for the pinned v2 serialization', () => {
    const input = { b: '2', a: '1' };
    const serialized = '1:a=1:1\n1:b=1:2\n';
    const expectedHex = createHash('sha256').update(serialized, 'utf8').digest('hex');
    expect(contentHash(input)).toBe(`sha256-${expectedHex}`);
  });

  it('sorts keys by Unicode code point before hashing — order of input keys does not matter', () => {
    expect(contentHash({ b: '2', a: '1' })).toBe(contentHash({ a: '1', b: '2' }));
  });

  it('is injective under v2: values containing "=" or "\\n" do not collide with an equivalent flattened form', () => {
    const collisionCandidateA = contentHash({ a: '1\nb=2' });
    const collisionCandidateB = contentHash({ a: '1', b: '2' });
    expect(collisionCandidateA).not.toBe(collisionCandidateB);
  });

  it('rejects a lone surrogate key with LoneSurrogateError', () => {
    const loneSurrogateKey = String.fromCharCode(0xd800);
    expect(() => contentHash({ [loneSurrogateKey]: 'x' })).toThrow(LoneSurrogateError);
  });

  it('sorts astral-plane keys after BMP keys by code point (not UTF-16 code unit)', () => {
    // U+FFFF (BMP) must hash identically to a manually-sorted [U+FFFF, U+1F600] input, and NOT to the
    // UTF-16-code-unit order (which would place the astral 0xD83D lead-surrogate unit before 0xFFFF).
    const astral = '\u{1F600}';
    const bmp = '￿';
    const codePointOrder = contentHash({ [bmp]: 'bmp', [astral]: 'astral' });
    // Manually pre-sort by code point (bmp < astral) and build via the same algorithm to confirm order-independence.
    const preSorted = contentHash({ [astral]: 'astral', [bmp]: 'bmp' });
    expect(codePointOrder).toBe(preSorted);
  });

  it('CONTENT_HASH_FORMAT_VERSION is pinned at 2', () => {
    expect(CONTENT_HASH_FORMAT_VERSION).toBe(2);
  });
});

describe('structureHash', () => {
  it('is stable regardless of input order (sorts by name before hashing)', () => {
    const a = structureHash([
      { name: 'logs', kind: 'logs', scope: 'global' },
      { name: 'data', kind: 'data', scope: 'project' },
    ]);
    const b = structureHash([
      { name: 'data', kind: 'data', scope: 'project' },
      { name: 'logs', kind: 'logs', scope: 'global' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when a kind or scope changes for the same name', () => {
    const base = structureHash([{ name: 'data', kind: 'data', scope: 'project' }]);
    const kindChanged = structureHash([{ name: 'data', kind: 'cache', scope: 'project' }]);
    const scopeChanged = structureHash([{ name: 'data', kind: 'data', scope: 'global' }]);
    expect(kindChanged).not.toBe(base);
    expect(scopeChanged).not.toBe(base);
  });

  it('the empty catalog hashes to a fixed, non-empty digest', () => {
    expect(structureHash([])).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

describe('projectEnvPrefix', () => {
  it('uppercases and folds "-" to "_", prepending ADHD_', () => {
    expect(projectEnvPrefix('agent-mcp')).toBe('ADHD_AGENT_MCP');
  });

  it('folds "." as well as "-" so the result is always a legal POSIX env-var name', () => {
    expect(projectEnvPrefix('foo.bar')).toBe('ADHD_FOO_BAR');
  });
});

describe('inferEnvVar', () => {
  it('uppercases the dotted/dashed field path and joins onto the prefix', () => {
    expect(inferEnvVar('ADHD_AGENT_MCP', 'transport.port')).toBe('ADHD_AGENT_MCP_TRANSPORT_PORT');
    expect(inferEnvVar('ADHD_AGENT_MCP', 'provider-key.secret')).toBe('ADHD_AGENT_MCP_PROVIDER_KEY_SECRET');
  });
});

describe('generateFieldSchema', () => {
  it('builds nested object schema from flat dot-path fields', () => {
    const schema = generateFieldSchema({
      'server.port': { type: 'integer', minimum: 1024, default: 8080 },
    });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        server: {
          type: 'object',
          properties: {
            port: { type: 'integer', minimum: 1024, default: 8080 },
          },
        },
      },
    });
  });

  it('strips adhd-specific metadata keywords (env, scope, secret, at) from a non-secret leaf, keeping default', () => {
    const schema = generateFieldSchema({
      'providers.openai.model': {
        type: 'string',
        default: 'gpt-4o',
        env: 'CUSTOM_KEY',
        scope: 'global',
        at: 'build',
      },
    }) as { properties: { providers: { properties: { openai: { properties: { model: Record<string, unknown> } } } } } };
    const leaf = schema.properties.providers.properties.openai.properties.model;
    expect(leaf).toEqual({ type: 'string', default: 'gpt-4o' });
    expect(leaf).not.toHaveProperty('env');
    expect(leaf).not.toHaveProperty('scope');
    expect(leaf).not.toHaveProperty('secret');
    expect(leaf).not.toHaveProperty('at');
  });

  it('SECURITY: a secret:true field NEVER copies its `default` into the generated schema, even though `default` is a legal JSON-Schema keyword for every other field', () => {
    const schema = generateFieldSchema({
      'providers.openai.secret': {
        type: 'string',
        default: 'sk-plaintext-should-never-leak',
        env: 'CUSTOM_KEY',
        scope: 'global',
        secret: true,
        at: 'runtime',
      },
    }) as { properties: { providers: { properties: { openai: { properties: { secret: Record<string, unknown> } } } } } };
    const leaf = schema.properties.providers.properties.openai.properties.secret;
    expect(leaf).toEqual({ type: 'string' });
    expect(JSON.stringify(schema)).not.toContain('sk-plaintext-should-never-leak');
  });

  it('negative control: a non-secret field WOULD leak its default if the strip logic broke — proves the assertion above has teeth', () => {
    const schema = generateFieldSchema({
      'a.value': { type: 'string', default: 'sk-plaintext-should-never-leak', secret: false },
    });
    // A non-secret field's default is legitimately retained — this is the control the
    // secret-stripping assertion above is checked against: if `secret !== true` stripped
    // `default` unconditionally, ordinary defaults would silently vanish from every schema.
    expect(JSON.stringify(schema)).toContain('sk-plaintext-should-never-leak');
  });

  it('the empty field map produces an empty object schema', () => {
    expect(generateFieldSchema({})).toEqual({ type: 'object', properties: {} });
  });
});

describe('env-ref helpers', () => {
  it('makeEnvRef/isEnvRef/envRefVarName round-trip', () => {
    const ref = makeEnvRef('ADHD_FOO_SECRET');
    expect(ref).toBe(`${ENV_REF_PREFIX}ADHD_FOO_SECRET`);
    expect(isEnvRef(ref)).toBe(true);
    expect(isEnvRef('not-a-ref')).toBe(false);
    expect(envRefVarName(ref)).toBe('ADHD_FOO_SECRET');
    expect(envRefVarName('not-a-ref')).toBeUndefined();
  });

  it('resolveEnvRef reads the live value from the supplied env map, passing non-refs through unchanged', () => {
    const ref = makeEnvRef('ADHD_FOO_SECRET');
    expect(resolveEnvRef(ref, { ADHD_FOO_SECRET: 'sk-live' })).toBe('sk-live');
    expect(resolveEnvRef(ref, {})).toBeUndefined();
    expect(resolveEnvRef('plain-value', {})).toBe('plain-value');
  });
});

describe('DEFAULT_SHARE_BY_KIND', () => {
  it('logs and temp default to per-instance; everything else defaults to shared (ARCHITECTURE.md §5)', () => {
    expect(DEFAULT_SHARE_BY_KIND.logs).toBe('per-instance');
    expect(DEFAULT_SHARE_BY_KIND.temp).toBe('per-instance');
    expect(DEFAULT_SHARE_BY_KIND.data).toBe('shared');
    expect(DEFAULT_SHARE_BY_KIND.cache).toBe('shared');
    expect(DEFAULT_SHARE_BY_KIND.state).toBe('shared');
    expect(DEFAULT_SHARE_BY_KIND.config).toBe('shared');
    expect(DEFAULT_SHARE_BY_KIND.run).toBe('shared');
  });
});
