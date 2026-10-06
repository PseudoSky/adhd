/**
 * resolve-selection.test.ts — 5ad2cf37 (D-G(2)).
 *
 * The ticket's single AC sentence, split into numbered clauses:
 *   5ad2cf37 AC1 — an agent with NO provider + a session binding resolves, and the
 *                  model reaches the provider as the WIRE string (claude-sonnet-4-6),
 *                  resolved through a REAL seeded registry — never the canonical slug.
 *   5ad2cf37 AC2 — negative control: drop the session tier -> NO_PROVIDER_SELECTED,
 *                  never an implicit `claudecli`.
 *   5ad2cf37 AC4 — global tier: with no task/session/agent binding the host default wins.
 *   (AC3 reopen-persistence lives in agent-store-runtime session-store.test.ts and the
 *    agent-mcp e2e; AC1/AC3 through the loaded MCP tool live in agent-mcp.)
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_FOLDER,
  createProviderRegistry,
  runMigrationsOn,
  seed,
} from '@adhd/agent-core-provider';
import type { ProviderRegistry } from '@adhd/agent-core-provider';

import {
  platformForProvider,
  providerConfigToBinding,
  requireSelection,
  resolveSelection,
  resolveWireModel,
  PROVIDER_DEFAULT_MODEL,
} from '../providers/resolve-selection.js';
import { buildProviderForSelection, resolveTaskSelection } from '../providers/construct.js';
import type { AgentDefinition } from '../validation/index.js';

let tmpDir: string;
let sqlite: Database.Database;
let registry: ProviderRegistry;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-selection-'));
  sqlite = new Database(path.join(tmpDir, 'registry.db'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  runMigrationsOn(sqlite, db, MIGRATIONS_FOLDER);
  seed(db);
  registry = createProviderRegistry(db);
});

afterEach(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const providerless: AgentDefinition = {
  name: 'no-provider',
  version: 1,
  mcpServers: {},
  permissions: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const config = {
  getProviderConfig: (o: { inlineModel?: string }) => ({ secret: 'sk-test', model: o.inlineModel }),
  defaultSelection: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;
const logger = { info() {}, warn() {}, error() {}, debug() {} };

describe('5ad2cf37 AC1 — session binding on a provider-less agent resolves to the WIRE string', () => {
  it('canonical ref -> claude-sonnet-4-6 (anthropic/claude_api) and sonnet (claudecli/claude_code)', () => {
    const anth = resolveTaskSelection({
      agentDefinition: providerless,
      sessionBinding: { providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' },
      config,
      registry,
    });
    expect(anth.selection.modelRef).toBe('claude_sonnet_4_6');
    expect(anth.wireModel).toBe('claude-sonnet-4-6');

    const cli = resolveTaskSelection({
      agentDefinition: providerless,
      sessionBinding: { providerType: 'claudecli', modelRef: 'claude_sonnet_4_6' },
      config,
      registry,
    });
    expect(cli.wireModel).toBe('sonnet');
  });

  it('the constructed provider carries the wire string, not the canonical slug', () => {
    const { selection } = resolveTaskSelection({
      agentDefinition: providerless,
      sessionBinding: { providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' },
      config,
      registry,
    });
    const provider = buildProviderForSelection({
      agentDefinition: providerless,
      selection,
      config,
      logger,
      registry,
    }) as unknown as { providerConfig: { model?: string } };
    expect(provider.providerConfig.model).toBe('claude-sonnet-4-6');
  });

  it('a legacy wire string migrated verbatim into modelRef passes through; openai (no bindings) too', () => {
    expect(resolveWireModel({ providerType: 'anthropic', modelRef: 'claude-sonnet-4-6' }, registry)).toBe(
      'claude-sonnet-4-6'
    );
    expect(resolveWireModel({ providerType: 'openai', modelRef: 'gpt-4o-mini' }, registry)).toBe('gpt-4o-mini');
    expect(platformForProvider('openai')).toBeUndefined();
  });

  it('the provider-default sentinel resolves to no wire model', () => {
    expect(
      resolveWireModel({ providerType: 'claudecli', modelRef: PROVIDER_DEFAULT_MODEL }, registry)
    ).toBeUndefined();
  });
});

describe('5ad2cf37 AC2 — fail closed (no implicit claudecli)', () => {
  it('no tier supplies a provider -> NO_PROVIDER_SELECTED', () => {
    expect(resolveSelection({})).toBeNull();
    expect(() => requireSelection({ agent: undefined })).toThrowError(
      expect.objectContaining({ code: 'NO_PROVIDER_SELECTED' })
    );
    expect(() =>
      resolveTaskSelection({ agentDefinition: providerless, config, registry })
    ).toThrowError(expect.objectContaining({ code: 'NO_PROVIDER_SELECTED' }));
  });

  it('NC: dropping the session tier from the AC1 setup fails closed, not claudecli', () => {
    let thrown: { code?: string } | undefined;
    try {
      resolveTaskSelection({ agentDefinition: providerless, sessionBinding: null, config, registry });
    } catch (e) {
      thrown = e as { code?: string };
    }
    expect(thrown?.code).toBe('NO_PROVIDER_SELECTED');
  });

  it('a provider type with no model also fails closed', () => {
    expect(resolveSelection({ session: { providerType: 'anthropic' } })).toBeNull();
  });
});

describe('5ad2cf37 AC4 — global tier', () => {
  it('with no task/session/agent binding the host default resolves', () => {
    const out = resolveTaskSelection({
      agentDefinition: providerless,
      config: { ...config, defaultSelection: { providerType: 'anthropic', modelRef: 'claude_sonnet_4_6' } },
      registry,
    });
    expect(out.selection.providerType).toBe('anthropic');
    expect(out.wireModel).toBe('claude-sonnet-4-6');
  });
});

describe('selection chain semantics', () => {
  it('first tier wins per field: task > session > agent > global', () => {
    const s = resolveSelection({
      task: { modelRef: 't' },
      session: { providerType: 'openai', modelRef: 's', timeoutMs: 5 },
      agent: { providerType: 'openai', modelRef: 'a', timeoutMs: 9, maxTokens: 7 },
      global: { providerType: 'openai', modelRef: 'g' },
    });
    expect(s).toMatchObject({ providerType: 'openai', modelRef: 't', timeoutMs: 5, maxTokens: 7 });
  });

  it('a session that only sets the model overrides the agent model and keeps the agent provider', () => {
    const s = resolveSelection({
      session: { modelRef: 'gpt-4o' },
      agent: providerConfigToBinding({ type: 'openai', model: 'gpt-4o-mini' }),
    });
    expect(s).toMatchObject({ providerType: 'openai', modelRef: 'gpt-4o' });
  });

  it("a lower tier naming ANOTHER provider never leaks its model into the winner", () => {
    const s = resolveSelection({
      session: { providerType: 'anthropic' },
      agent: { providerType: 'openai', modelRef: 'gpt-4o-mini', baseURL: 'http://x/v1' },
    });
    expect(s).toBeNull(); // anthropic has no model of its own; openai's must not be borrowed
  });
});
