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
import { fileURLToPath } from 'node:url';

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
