/**
 * BUG-MCP-HOME-EXPAND-001 regression guard: the repo's committed `.mcp.json`
 * `agent-mcp-published` entry must never carry `${VAR}` literals in its `env`
 * block — MCP hosts (opencode) pass env values through WITHOUT shell/variable
 * expansion, so `${HOME}/...` reaches the server as the literal string and the
 * published (npx) entry breaks with garbage DB paths. The published server
 * resolves the same locations zero-config via the `@adhd/environment` cascade
 * (no `ADHD_ENV_SCOPE` ⇒ global scope rooted at `~/.adhd/…`, per
 * `environment-core-node`'s own scope spec) plus `loadEnvHierarchy()`
 * (`src/utils/load-env.ts`, which already loads `~/.adhd/.env`) — so no env
 * overrides are needed at all.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface McpServerEntry {
  type: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

describe('.mcp.json — agent-mcp-published registration', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const mcpJson = JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, McpServerEntry>;
  };

  it('registers agent-mcp-published via the published npm artifact', () => {
    const entry = mcpJson.mcpServers['agent-mcp-published'];
    expect(entry, 'agent-mcp-published must stay registered').toBeDefined();
    expect(entry.command).toBe('npx');
    expect(entry.args).toContain('@adhd/agent-mcp@latest');
  });

  it('BUG-MCP-HOME-EXPAND-001: no env value contains an unexpandable ${VAR} literal (hosts pass env through verbatim)', () => {
    const entry = mcpJson.mcpServers['agent-mcp-published'];
    const env = entry?.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      expect(value, `agent-mcp-published env "${key}" must not contain \${...}`).not.toMatch(/\$\{/);
    }
  });
});
