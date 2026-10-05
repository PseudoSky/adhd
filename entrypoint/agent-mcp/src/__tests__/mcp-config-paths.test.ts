/**
 * Test-per-AC for backlog b94fe805 + 5c51eeb6: the repo `.mcp.json` registry
 * override must point at the canonical shared registry DB, not the
 * non-canonical, schema-only (4096 B) duplicate under `agent-mcp/`.
 *
 * These read the committed config file and assert the corrected value — they
 * fail if the override is reverted to the old path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFlatLegacyDbPath } from '../db/migrate-legacy.js';

const mcpJsonPath = fileURLToPath(new URL('../../../../.mcp.json', import.meta.url));

interface IMcpDoc {
  mcpServers: Record<
    string,
    { env?: Record<string, string> }
  >;
}

function registryOverride(): string | undefined {
  const doc = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as IMcpDoc;
  return doc.mcpServers['agent-mcp-published']?.env?.['ADHD_AGENT_REGISTRY_DB_PATH'];
}

function operationalOverride(): string | undefined {
  const doc = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as IMcpDoc;
  return doc.mcpServers['agent-mcp-published']?.env?.['ADHD_AGENT_DATABASE_PATH'];
}

/** The canonical namespaced operational store the code declares: config.ts's
 *  `dirs.data.scope:'global'` pin + `files.db` leaf, db/client.ts's zero-config
 *  fallback (`operationalEnv.files.db`). */
const CANONICAL_OPERATIONAL_DB = join(
  homedir(),
  '.adhd',
  'agent-mcp',
  'production',
  'data',
  'agents.db',
);

describe('.mcp.json registry override (b94fe805, 5c51eeb6)', () => {
  it('AC1: the override is set and resolves the canonical agent-registry DB', () => {
    const value = registryOverride();
    expect(value).toBeDefined();
    expect(value).toMatch(/\.adhd\/agent-registry\/production\/data\/registry\.db$/);
  });

  it('AC2: it does NOT point at the non-canonical schema-only agent-mcp/registry.db', () => {
    const value = registryOverride();
    expect(value).not.toMatch(/agent-mcp\/registry\.db$/);
  });
});

describe('.mcp.json operational override (7acc68c1)', () => {
  it('AC1: the override is the canonical namespaced operational store', () => {
    expect(operationalOverride()).toBe(CANONICAL_OPERATIONAL_DB);
  });

  it('AC2: it is NOT the flat legacy path (~/.adhd/agent-mcp/agents.db)', () => {
    const value = operationalOverride();
    expect(value).toBeDefined();
    expect(value).not.toBe(resolveFlatLegacyDbPath());
    expect(value).not.toMatch(/\.adhd\/agent-mcp\/agents\.db$/);
  });

  it("AC3: db/client.ts's resolution expression (config.db.path ?? files.db) is canonical", () => {
    // Mirrors the real resolver: db/client.ts opens `path.resolve(config.db.path
    // ?? files.db)`. `config.db.path` IS the .mcp.json override (the env layer
    // wins), and the zero-config fallback (`operationalEnv.files.db`) resolves to
    // the same canonical path (proven against the real singleton in
    // config.scope-resolution.test.ts), so the resolved operational DB path is
    // canonical whether the override is present or dropped.
    const resolved = resolve(operationalOverride() ?? CANONICAL_OPERATIONAL_DB);
    expect(resolved).toBe(CANONICAL_OPERATIONAL_DB);
    expect(resolved.endsWith(join('agent-mcp', 'production', 'data', 'agents.db'))).toBe(true);
  });
});
