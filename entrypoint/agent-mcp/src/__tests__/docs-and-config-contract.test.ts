/**
 * docs-and-config-contract.test.ts — AC-per-AC proof for the Bucket C docs/config
 * items. Each `it` fails if its fix is reverted (the repo requires a teeth-having
 * test per acceptance criterion; a direct read is not proof).
 *
 *   cecf2a94 — architecture-and-security.md states the THREE real provider types.
 *   3c79bf07 — guide() USAGE_GUIDE documents Workflow 5 (depends_on chaining).
 *   d58c1155 — live-test gate approval + named owner in README + AGENTS.md + headers.
 *   NAT-TOOL-4 — the authored `tools/mcp-shell` fallback (server.mjs + security.yaml)
 *              is permanently removed and no runtime source references it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url)); // entrypoint/agent-mcp/src/__tests__
const pkgRoot = resolve(here, '..', '..'); // entrypoint/agent-mcp
const repoRoot = resolve(pkgRoot, '..', '..'); // repo root
const read = (p: string): string => readFileSync(p, 'utf8');

describe('cecf2a94 — architecture-and-security.md provider claims', () => {
  const doc = read(resolve(pkgRoot, 'docs', 'architecture-and-security.md'));

  it('AC1: the Provider Adapters diagram lists the three real adapters and no DeepSeek/Gemini adapter', () => {
    expect(doc).toMatch(/Provider Adapters/);
    expect(doc).toContain('claudecli');
    expect(doc).not.toMatch(/^\s*\|?\s*\+-- DeepSeek/m);
    expect(doc).not.toMatch(/^\s*\|?\s*\+-- Gemini/m);
  });

  it('AC2: the Provider-Specific Differences table has three columns (no DeepSeek/Gemini columns)', () => {
    expect(doc).not.toMatch(/\|\s*DeepSeek\s*\|\s*Gemini\s*\|/);
    expect(doc).toMatch(/\|\s*Aspect\s*\|\s*Anthropic\s*\|\s*OpenAI[^|]*\|\s*claudecli\s*\|/);
  });

  it('AC3: the doc explicitly states there is no deepseek/gemini provider type (deepseek via env.base_url)', () => {
    expect(doc).toMatch(/no `?deepseek`? and no `?gemini`? provider/i);
    expect(doc).toMatch(/env\.base_url/);
  });
});

describe('3c79bf07 — guide() documents the depends_on serialized chain', () => {
  const server = read(resolve(pkgRoot, 'src', 'server.ts'));

  it('AC1: USAGE_GUIDE has a Workflow 5 section (after Workflow 4) covering depends_on + on_upstream_failure', () => {
    const wf4 = server.indexOf('## Workflow 4');
    const wf5 = server.indexOf('## Workflow 5');
    const next = server.indexOf('## Updating an agent definition');
    expect(wf4).toBeGreaterThan(-1);
    expect(wf5).toBeGreaterThan(wf4);
    expect(next).toBeGreaterThan(wf5);
    const section = server.slice(wf5, next);
    expect(section).toContain('depends_on');
    expect(section).toContain('on_upstream_failure');
  });
});

describe('d58c1155 — env-gated live tests carry a named-owner approval', () => {
  const OWNER = 'pseudosky';

  it('AC1: agent-mcp README documents the gates and names the owner', () => {
    const readme = read(resolve(pkgRoot, 'README.md'));
    expect(readme).toMatch(/Live tests/);
    expect(readme).toContain(OWNER);
    expect(readme).toContain('AGENT_MCP_LIVE');
    expect(readme).toContain('AGENT_MCP_BUDGET_LIVE');
  });

  it('AC2: agent-mcp AGENTS.md documents the gates and names the owner', () => {
    const agentsMd = read(resolve(pkgRoot, 'AGENTS.md'));
    expect(agentsMd).toMatch(/Live tests/);
    expect(agentsMd).toContain(OWNER);
  });

  it('AC3: each gated test header names the approval and references AGENTS.md §7', () => {
    for (const f of ['live-budget.e2e.test.ts', 'live-dag.e2e.test.ts', 'live-oauth.e2e.test.ts']) {
      const src = read(resolve(pkgRoot, 'src', '__tests__', 'integration', f));
      expect(src, `${f} must name the approval owner`).toContain(OWNER);
      expect(src, `${f} must reference AGENTS.md`).toMatch(/AGENTS\.md/);
    }
  });
});

describe('NAT-TOOL-4 — the authored mcp-shell fallback is permanently removed', () => {
  it('AC4: the retired fallback files are gone', () => {
    expect(existsSync(resolve(repoRoot, 'tools', 'mcp-shell', 'server.mjs'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'tools', 'mcp-shell', 'security.yaml'))).toBe(false);
  });

  it('AC4: no runtime source references the retired server or its env override', () => {
    for (const rel of [
      ['src', 'defaults.ts'],
      ['src', 'server.ts'],
      ['src', 'index.ts'],
      ['src', 'srt-policy.ts'],
    ]) {
      const src = read(resolve(pkgRoot, ...rel));
      expect(src, `${rel.join('/')} must not reference the retired server`).not.toContain(
        'mcp-shell/server.mjs'
      );
      expect(src, `${rel.join('/')} must not reference the retired env var`).not.toContain(
        'ADHD_AGENT_SHELL_MCP_PATH'
      );
    }
  });
});

describe('c00ad483 — provider-call-audit.md cites real source paths', () => {
  const doc = read(resolve(pkgRoot, 'docs', 'provider-call-audit.md'));

  it('AC1: no dead packages/ai/... source path remains', () => {
    expect(doc).not.toMatch(/packages\/ai\//);
  });

  it('AC2: the orchestrator + provider citations point at the real monorepo homes', () => {
    expect(doc).toContain('packages/agent/agent-engine-orchestrator/src/engine/orchestrator.ts');
    expect(doc).toContain('packages/agent/agent-engine-orchestrator/src/providers/openai.ts');
  });
});

describe('d965f490 — project.json dist-manifest comment cites a real test file', () => {
  const projectJson = read(resolve(pkgRoot, 'project.json'));

  it('AC1: the comment names agents-import.e2e.test.ts and no longer the non-existent agent-mcp-registry.e2e', () => {
    expect(projectJson).not.toContain('agent-mcp-registry.e2e');
    expect(projectJson).toContain('agents-import.e2e.test.ts');
  });

  it('AC2: the named file actually exists in dispatch-cli', () => {
    expect(
      existsSync(
        resolve(repoRoot, 'entrypoint', 'dispatch-cli', 'src', 'test', 'agents-import.e2e.test.ts')
      )
    ).toBe(true);
  });

  it('AC3: dispatch-cli project.json no longer cites the non-existent agent-mcp-registry.e2e.test.ts', () => {
    const dispatchProjectJson = read(
      resolve(repoRoot, 'entrypoint', 'dispatch-cli', 'project.json')
    );
    expect(dispatchProjectJson).not.toContain('agent-mcp-registry.e2e');
    expect(dispatchProjectJson).toContain('helpers/agent-mcp-registry.ts');
  });
});
