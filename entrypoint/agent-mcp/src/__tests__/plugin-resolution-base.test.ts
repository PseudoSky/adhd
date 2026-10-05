import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EngineLogger } from '@adhd/agent-engine-orchestrator';
import { resolveSpecifier } from '@adhd/agent-engine-orchestrator';
import type { IHookRegistry } from '@adhd/agent-base-types';

import { AGENT_MCP_PLUGIN_RESOLUTION_BASE, loadDefaultPlugins } from '../plugins/load-defaults.js';

/**
 * Backlog cc636860 — the PUBLISHED-layout residual of dfb03557. The engine
 * loader resolved a bare specifier only from `[cwd, the orchestrator's module
 * dir]`; the default budget plugin is an OPTIONAL peer of the orchestrator
 * (not auto-installed for a published consumer) but a REGULAR dependency of
 * agent-mcp. This proves agent-mcp makes its own module base available to the
 * loader and that the default entry resolves+installs through it, and that the
 * extra-base mechanism itself works (a fabricated package resolvable ONLY from
 * a supplied base).
 */

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function capturingHooks(): {
  hooks: IHookRegistry;
  registered: Array<{ hook: string; kind: 'register' | 'enforcement' }>;
} {
  const registered: Array<{ hook: string; kind: 'register' | 'enforcement' }> = [];
  const hooks = {
    register: (hook: string) => registered.push({ hook, kind: 'register' }),
    registerEnforcement: (hook: string) => registered.push({ hook, kind: 'enforcement' }),
    emit: async () => undefined,
    enforce: async () => undefined,
  } as unknown as IHookRegistry;
  return { hooks, registered };
}

interface LogLine {
  msg: unknown;
  args: unknown[];
}

function capturingLogger(): { logger: EngineLogger; logs: LogLine[] } {
  const logs: LogLine[] = [];
  const push = (msg: unknown, args: unknown[]) => logs.push({ msg, args });
  const logger: EngineLogger = {
    info: (msg, ...args) => push(msg, args),
    warn: (msg, ...args) => push(msg, args),
    error: (msg, ...args) => push(msg, args),
    debug: () => undefined,
  };
  return { logger, logs };
}

describe('default budget plugin resolution from agent-mcp base (cc636860)', () => {
  it('AGENT_MCP_PLUGIN_RESOLUTION_BASE points at a real directory', () => {
    expect(existsSync(AGENT_MCP_PLUGIN_RESOLUTION_BASE)).toBe(true);
  });

  it('resolveSpecifier consults an extra base — teeth: the fabricated package is unresolvable otherwise', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cc636860-base-'));
    cleanup.push(base);
    const pkgDir = join(base, 'node_modules', '@probe', 'only-via-base');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@probe/only-via-base', version: '1.0.0', main: 'index.js' })
    );
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');

    // Resolves ONLY because the supplied base is consulted.
    await expect(resolveSpecifier('@probe/only-via-base', [base])).resolves.toContain(
      'only-via-base'
    );
    // NEGATIVE CONTROL: with no extra base it is not resolvable from cwd or the
    // orchestrator's module dir — proving the first assertion exercises the base.
    await expect(resolveSpecifier('@probe/only-via-base')).rejects.toThrow(
      /Cannot resolve plugin/
    );
  });

  it("loadDefaultPlugins installs the default budget plugin using agent-mcp's own base", async () => {
    const { hooks, registered } = capturingHooks();
    const { logger, logs } = capturingLogger();

    // A non-existent explicit config path = no operator config file loads
    // (hermetic — the developer's ~/.adhd config can never leak in).
    const noConfig = join(tmpdir(), 'cc636860-no-such-config.json');
    await loadDefaultPlugins(hooks, {}, logger, { configPath: noConfig });

    // The budget plugin's install() ran (pre:model_request enforcement is
    // uniquely its own).
    expect(registered).toContainEqual({ hook: 'pre:model_request', kind: 'enforcement' });
    expect(registered).toContainEqual({ hook: 'pre:tool_call', kind: 'enforcement' });

    const installed = logs.find(
      (l) =>
        l.args[0] === 'External plugin installed' &&
        (l.msg as Record<string, unknown> | undefined)?.['plugin'] === 'agent-mcp-budget'
    );
    expect(installed).toBeDefined();
    expect(
      logs.find((l) => l.args[0] === 'Plugin resolution failed — skipping')
    ).toBeUndefined();
  });
});
