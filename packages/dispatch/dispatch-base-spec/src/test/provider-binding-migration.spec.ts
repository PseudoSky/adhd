/**
 * d3f1f787 / b578a483 (D-G(1)) — AC4: snake_case provider config is gone from
 * the dispatch DAG; v4 documents migrate to the shared camelCase PartialBinding.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as spec from '../index.js';
import { migrateDag, upgradeDagToCurrent } from '../lib/migrate.js';

const V4_PROVIDERS = {
  Sonnet: {
    type: 'openai',
    model_id: 'deepseek-chat',
    env_secret: 'ADHD_AGENT_DEEPSEEK_SECRET',
    base_url: 'https://api.deepseek.com/v1',
    timeout_ms: 180000,
    retry_config: { retries: 2, min_timeout: 1000, max_timeout: 5000, factor: 2 },
  },
  Haiku: {
    type: 'claudecli',
    model_id: 'claude-haiku-4-5',
    env_secret: null,
    base_url: null,
    timeout_ms: 60000,
    retry_config: { retries: 3, min_timeout: 1, max_timeout: 2, factor: 2 },
  },
};

describe('d3f1f787 AC4 — snake_case provider config is gone / v4 migrates', () => {
  it('v4 -> v5 converts every provider entry to a camelCase PartialBinding', () => {
    const dag: Record<string, unknown> = {
      schema_version: 4,
      providers: JSON.parse(JSON.stringify(V4_PROVIDERS)),
    };
    migrateDag(4, 5, dag);
    expect(dag['schema_version']).toBe(5);
    expect(dag['providers']).toEqual({
      Sonnet: {
        providerType: 'openai',
        modelRef: 'deepseek-chat',
        env: { secret: 'ADHD_AGENT_DEEPSEEK_SECRET' },
        baseURL: 'https://api.deepseek.com/v1',
        timeoutMs: 180000,
        retryConfig: { retries: 2, minTimeout: 1000, maxTimeout: 5000, factor: 2 },
      },
      Haiku: {
        providerType: 'claudecli',
        modelRef: 'claude-haiku-4-5',
        timeoutMs: 60000,
        retryConfig: { retries: 3, minTimeout: 1, maxTimeout: 2, factor: 2 },
      },
    });
    // No snake_case key survives anywhere in the migrated providers.
    expect(JSON.stringify(dag['providers'])).not.toMatch(
      /model_id|env_secret|base_url|timeout_ms|retry_config|min_timeout|max_timeout/
    );
  });

  it('is idempotent: upgrading an already-v5 document changes nothing', () => {
    const dag: Record<string, unknown> = {
      schema_version: 4,
      providers: JSON.parse(JSON.stringify(V4_PROVIDERS)),
    };
    upgradeDagToCurrent(dag);
    const once = JSON.stringify(dag);
    upgradeDagToCurrent(dag);
    expect(JSON.stringify(dag)).toBe(once);
    expect(dag['schema_version']).toBe(spec.CURRENT_DAG_SCHEMA_VERSION);
  });

  it('v2 documents chain all the way to the camelCase default providers', () => {
    const dag: Record<string, unknown> = {
      schema_version: 2,
      nodes: {},
      operations: [],
    };
    upgradeDagToCurrent(dag);
    const providers = dag['providers'] as Record<string, Record<string, unknown>>;
    expect(dag['schema_version']).toBe(5);
    expect(providers['Sonnet']).toMatchObject({
      providerType: 'claudecli',
      modelRef: 'claude-sonnet-4-5',
      timeoutMs: 120000,
    });
    expect(providers['Sonnet']).not.toHaveProperty('model_id');
  });

  it('the package no longer exports the snake_case ProviderConfig/RetryConfig runtime or type names', () => {
    // Types are erased at runtime; the source barrel is asserted textually.
    const barrel = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/\bProviderConfig\b/);
    expect(barrel).not.toMatch(/\bRetryConfig\b/);
    expect(barrel).toMatch(/\bPartialBinding\b/);
  });
});
