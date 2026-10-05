/**
 * docs-and-config-contract.test.ts — AC-per-AC proof for the Bucket C docs/config
 * items. Each `it` fails if its fix is reverted (the repo requires a teeth-having
 * test per acceptance criterion; a direct read is not proof).
 *
 *   cecf2a94 — architecture-and-security.md states the THREE real provider types.
 *   3c79bf07 — guide() USAGE_GUIDE documents Workflow 5 (depends_on chaining).
 *   d58c1155 — live-test gate approval + named owner in README + AGENTS.md + headers.
 *    f141baad — the mcp-shell security-config path is real: canonical file exists,
 *              the bogus scripts/ path is gone, and every catalog DB entry points
 *              its MCP_SHELL_SEC_CONFIG_FILE at an existing file. A repo-owned
 *              seeded fixture catalog (fixtures/catalog-shell-config.seed.json)
 *              makes AC2 assert unconditionally in CI, where no machine-global
 *              catalog exists.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url)); // entrypoint/agent-mcp/src/__tests__
const pkgRoot = resolve(here, '..', '..'); // entrypoint/agent-mcp
const repoRoot = resolve(pkgRoot, '..', '..'); // repo root
const read = (p: string): string => readFileSync(p, 'utf8');

/**
 * The f141baad AC2 assertion must not go vacuous in CI, where the machine-global
 * agent-mcp catalog does not exist. This seeds a repo-owned fixture catalog — a
 * real SQLite `agents` table built from the committed seed file
 * `fixtures/catalog-shell-config.seed.json` — so AC2 always has a catalog to
 * check. The seed records `MCP_SHELL_SEC_CONFIG_FILE` repo-relatively; the test
 * resolves it against the repo root, so a moved/renamed/deleted canonical
 * `tools/mcp-shell/security.yaml` (or a regression back to the removed bogus
 * `scripts/mcp-shell-security.yaml`) turns the assertion red.
 */
let fixtureCatalogDb: string | undefined;

function seedFixtureCatalog(): string {
  const seed = JSON.parse(
    read(resolve(here, 'fixtures', 'catalog-shell-config.seed.json'))
  ) as {
    agents: Array<{
      name: string;
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    }>;
  };
  // Ephemeral artifact under the canonical tmp/ root; removed in afterAll.
  const dir = resolve(
    repoRoot,
    'tmp',
    'agent-mcp',
    `docs-contract-fixture-${process.pid}`
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = resolve(dir, 'catalog.db');
  const db = new Database(dbPath);
  try {
    db.exec(
      'CREATE TABLE agents (name TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)'
    );
    const insert = db.prepare(
      'INSERT INTO agents (name, data) VALUES (?, ?)'
    );
    for (const agent of seed.agents) {
      for (const srv of Object.values(agent.mcpServers ?? {})) {
        const cfg = srv?.env?.['MCP_SHELL_SEC_CONFIG_FILE'];
        if (cfg && srv?.env && !isAbsolute(cfg)) {
          srv.env['MCP_SHELL_SEC_CONFIG_FILE'] = resolve(repoRoot, cfg);
        }
      }
      insert.run(
        agent.name,
        JSON.stringify({ name: agent.name, mcpServers: agent.mcpServers ?? {} })
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

beforeAll(() => {
  fixtureCatalogDb = seedFixtureCatalog();
});

afterAll(() => {
  if (fixtureCatalogDb) {
    rmSync(dirname(fixtureCatalogDb), { recursive: true, force: true });
  }
});


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

describe('f141baad — mcp-shell security-config path is real', () => {
  const canonical = resolve(repoRoot, 'tools', 'mcp-shell', 'security.yaml');
  const bogus = resolve(repoRoot, 'scripts', 'mcp-shell-security.yaml');

  it('AC1: the canonical security.yaml exists and the bogus scripts/ path does not', () => {
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(bogus)).toBe(false);
  });

  it('AC2: every catalog agent points MCP_SHELL_SEC_CONFIG_FILE at an existing file (typescript-deepseek == canonical)', () => {
    const candidates = discoverCatalogDbs();
    let checked = 0;
    for (const dbPath of candidates) {
      if (!existsSync(dbPath)) continue;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare('SELECT name, data FROM agents').all() as Array<{ name: string; data: string }>;
        for (const row of rows) {
          const parsed = JSON.parse(row.data) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
          };
          for (const srv of Object.values(parsed.mcpServers ?? {})) {
            const cfg = srv?.env?.['MCP_SHELL_SEC_CONFIG_FILE'];
            if (!cfg) continue;
            checked += 1;
            expect(existsSync(cfg), `${row.name} shell config ${cfg} must exist`).toBe(true);
            // Must be the per-repo mcp-shell policy, NOT the bogus scripts/ path. The
            // catalog is machine-global and may name the main checkout, so compare the
            // canonical relative suffix rather than an absolute path.
            if (row.name === 'typescript-deepseek') {
              expect(cfg.endsWith('/tools/mcp-shell/security.yaml')).toBe(true);
              expect(cfg).not.toContain('scripts/mcp-shell-security.yaml');
            }
          }
        }
      } finally {
        db.close();
      }
    }
    // The repo-owned seeded fixture catalog is always present, so AC2 is asserted
    // unconditionally — it no longer goes vacuous in CI (no machine-global catalog).
    expect(checked).toBeGreaterThan(0);
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

/** Catalog DBs the app may use: the path in .mcp.json plus the two default scopes. */
function discoverCatalogDbs(): string[] {
  const found = new Set<string>();
  const mcpJson = resolve(repoRoot, '.mcp.json');
  if (existsSync(mcpJson)) {
    try {
      const cfg = JSON.parse(readFileSync(mcpJson, 'utf8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      for (const s of Object.values(cfg.mcpServers ?? {})) {
        const p = s?.env?.['ADHD_AGENT_DATABASE_PATH'];
        if (p) found.add(p);
      }
    } catch {
      // malformed .mcp.json must not mask the f141baad assertions
    }
  }
  const home = process.env['HOME'];
  if (home) {
    found.add(resolve(home, '.adhd', 'agent-mcp', 'agents.db'));
    found.add(resolve(home, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db'));
  }
  // Repo-owned seeded fixture catalog — always present, so AC2 is never vacuous.
  if (fixtureCatalogDb) found.add(fixtureCatalogDb);
  return [...found];
}
