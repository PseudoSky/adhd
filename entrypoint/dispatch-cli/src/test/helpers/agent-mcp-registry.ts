/**
 * agent-mcp-registry.ts — shared harness for the real-agent-mcp e2e specs
 * (`dispatch-default-mcp-servers.e2e.test.ts`, `agents-import.e2e.test.ts`).
 *
 * Spawns the BUILT agent-mcp entry over stdio JSON-RPC and isolates the child
 * so the registry it touches is always the test's temp `ADHD_AGENT_DATABASE_PATH`,
 * never the real `~/.adhd` store or a repo-root `.env`-redirected dev store.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentMcpRunner } from '@adhd/dispatch-orchestrator';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// src/test/helpers/ -> repo root
export const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
export const TSCONFIG_BASE = join(REPO_ROOT, 'tsconfig.base.json');
export const FALLBACK_CLI_PATH = join(REPO_ROOT, 'entrypoint', 'dispatch-cli', 'bin', 'cli.ts');
export const AGENT_MCP_DIST = join(REPO_ROOT, 'entrypoint', 'agent-mcp', 'dist', 'src', 'index.js');
export const TMP_ROOT = join(REPO_ROOT, 'tmp', 'dispatch-cli', 'agent-mcp-registry-e2e');

const cleanupDirs: string[] = [];

/** A fresh, isolated scratch dir under the repo's canonical `tmp/<package>/` root. */
export function mkScratch(name: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `${name}-`));
  cleanupDirs.push(dir);
  return dir;
}

/** Create `<scratch>/home` and return it (the child's fake `$HOME`). */
export function mkFakeHome(scratch: string): string {
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

/** Tear down every scratch dir created by {@link mkScratch}. Call in `afterAll`. */
export function cleanupScratch(): void {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Fail LOUDLY (never silently skip) when the built agent-mcp entry is missing.
 * The dispatch-cli `test` target declares `dependsOn: ["agent-mcp:build"]`, so a
 * normal `nx test dispatch-cli` always produces it first.
 */
export function assertAgentMcpBuilt(): void {
  if (!existsSync(AGENT_MCP_DIST)) {
    throw new Error(
      `real-agent-mcp e2e: built agent-mcp entry not found at ${AGENT_MCP_DIST} — ` +
        `run \`npx nx build agent-mcp\` first (the test target dependsOn agent-mcp:build).`
    );
  }
}

/**
 * Build a child env that strips every ambient `ADHD_AGENT_*` key (so a runner's
 * pinned config can never reach the real `~/.adhd` store) before applying this
 * test's explicit overrides.
 */
export function buildChildEnv(
  overrides: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('ADHD_AGENT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * A real `AgentMcpRunner` pointed at the BUILT agent-mcp entry, against
 * `dbPath`, spawned with an isolated `cwd` (so no repo `.env` is found).
 */
export function makeRunner(opts: {
  dbPath: string;
  home: string;
  cwd: string;
  defaultMcpServers?: Record<string, Record<string, unknown>>;
  /** Extra child env vars merged over the isolated defaults. */
  extraEnv?: Record<string, string>;
}): AgentMcpRunner {
  return new AgentMcpRunner({
    command: process.execPath,
    args: [AGENT_MCP_DIST],
    cwd: opts.cwd,
    env: {
      HOME: opts.home,
      ADHD_AGENT_DATABASE_PATH: opts.dbPath,
      ADHD_AGENT_SSE_ENABLED: 'false',
      ADHD_AGENT_TRANSPORT: 'stdio',
      ...(opts.extraEnv ?? {}),
    },
    defaultMcpServers: opts.defaultMcpServers,
  });
}
