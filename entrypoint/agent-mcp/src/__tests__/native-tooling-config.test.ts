/**
 * NAT-TOOL-7 — the typed native-tooling config surface in `@adhd/environment`
 * (ADR-0008 D10). Ticket: 20006dff-bba3-4415-90a4-636fc2d2f9a7.
 *
 * Each `it` below is an AC with teeth (the do-nothing / pre-fix implementation
 * fails it):
 *   AC1 — a project-layer `nativeTooling.fs.root` overrides the global value.
 *   AC3 — grep: NO new feature-switch env var was introduced.
 *   AC4 — grep: `ephemeralAskPolicy` does NOT exist in the config surface.
 *   (AC2 — `nx lint environment-base-spec` exits 0 — is the command gate; its
 *    fast structural guard lives in environment-base-spec's own suite.)
 *
 * The two stateful tests construct a REAL `Environment<AgentMcpConfig>` from the
 * exported `agentMcpEnvironmentSpec` against isolated temp roots, exactly the
 * way `config.ts`'s `env` singleton is built, so the cascade is exercised
 * through the real components — not a unit test of internals.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';
import { nativeToolingConfigFieldSpecs } from '@adhd/environment-base-spec';
import { effectiveHitl } from '@adhd/agent-base-types';
import type { McpServerConfig } from '@adhd/agent-base-types';

import { agentMcpEnvironmentSpec, type AgentMcpConfig } from '../config.js';
import { nativeToolingFromResolvedConfig, withDefaultMcpServers } from '../defaults.js';

const here = dirname(fileURLToPath(import.meta.url)); // .../agent-mcp/src/__tests__
const pkgRoot = resolve(here, '..', '..'); // entrypoint/agent-mcp
const repoRoot = resolve(pkgRoot, '..', '..');
const read = (p: string): string => readFileSync(p, 'utf8');

// The two files NAT-TOOL-7 changes = "the config surface".
const agentMcpSrc = read(resolve(pkgRoot, 'src', 'config.ts'));
const baseSpecSrc = read(
  resolve(repoRoot, 'packages', 'environment', 'environment-base-spec', 'src', 'index.ts')
);

const cleanupDirs: string[] = [];

/** Isolated `adhdRoot` (the `global` root base) under this package's `tmp/`. */
function mkAdhdRoot(): string {
  const base = join(__dirname, '..', '..', '..', '..', 'tmp', 'agent-mcp', 'nat-tool-7-config-test');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'root-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Isolated cwd outside the repo tree; `withMarker` plants a `.adhd` project marker. */
function mkCwdFixture(withMarker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'adhd-agent-mcp-nat-tool-7-cwd-'));
  if (withMarker) mkdirSync(join(dir, '.adhd'), { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

function withEnvVar(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function makeEnv(adhdRoot: string, cwd: string) {
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    adhdRoot,
    cwd,
  });
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('NAT-TOOL-7 — native tooling config surface (ADR-0008 D10)', () => {
  it('AC1: a project-layer `nativeTooling.fs.root` overrides the global value per the cascade', () => {
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', 'project');
    const restoreRoot = withEnvVar('ADHD_AGENT_NATIVE_TOOLING_FS_ROOT', undefined);
    try {
      const adhdRoot = mkAdhdRoot();
      const cwd = mkCwdFixture(true); // `.adhd` marker → project root = cwd

      const globalDir = join(adhdRoot, 'agent-mcp', 'production');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'config.yaml'), 'nativeTooling:\n  fs:\n    root: /global/root\n');

      const projectDir = join(cwd, '.adhd', 'agent-mcp', 'production');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'config.yaml'), 'nativeTooling:\n  fs:\n    root: /project/root\n');

      const env = makeEnv(adhdRoot, cwd);
      expect(env.scope).toBe('project');
      expect(env.config.nativeTooling.fs.root).toBe('/project/root');
      // Provenance proves WHICH layer won — not just the value.
      expect(env.get('provenance.nativeTooling.fs.root')).toMatchObject({ source: 'project' });

      // Negative control: drop the project layer → the GLOBAL value wins. If the
      // assertion above were satisfied by anything other than the project layer,
      // this fails.
      rmSync(join(projectDir, 'config.yaml'));
      const envGlobalOnly = makeEnv(adhdRoot, cwd);
      expect(envGlobalOnly.config.nativeTooling.fs.root).toBe('/global/root');
      expect(envGlobalOnly.get('provenance.nativeTooling.fs.root')).toMatchObject({ source: 'global' });

      // The env-var layer is the highest — proves the field is fully wired into
      // the cascade, not only the file layers.
      const restoreEnvLayer = withEnvVar('ADHD_AGENT_NATIVE_TOOLING_FS_ROOT', '/env/root');
      try {
        const envOverride = makeEnv(adhdRoot, cwd);
        expect(envOverride.config.nativeTooling.fs.root).toBe('/env/root');
        expect(envOverride.get('provenance.nativeTooling.fs.root')).toMatchObject({
          source: 'env',
          env: 'ADHD_AGENT_NATIVE_TOOLING_FS_ROOT',
        });
      } finally {
        restoreEnvLayer();
      }
    } finally {
      restoreRoot();
      restoreScope();
    }
  });

  it('AC3: grep proves NO new feature-switch env var was introduced', () => {
    const FEATURE_SWITCH = /(^|_)(ENABLE|ENABLED|DISABLE|DISABLED|TOGGLE)(_|$)/i;

    const envNames = Object.values(nativeToolingConfigFieldSpecs('ADHD_AGENT'))
      .map((f) => f.env)
      .filter((e): e is string => typeof e === 'string');
    expect(envNames.length).toBeGreaterThan(0);
    for (const name of envNames) {
      expect(FEATURE_SWITCH.test(name), `${name} must not be a feature-switch env var`).toBe(false);
      // ADR-0008 D10: no whole-subsystem `*_NATIVE_TOOLING` toggle either.
      expect(/_NATIVE_TOOLING$/i.test(name), `${name} must not be a subsystem toggle`).toBe(false);
    }

    // Grep the two changed source files for a feature-switch literal.
    for (const [label, source] of [
      ['config.ts', agentMcpSrc],
      ['environment-base-spec/src/index.ts', baseSpecSrc],
    ] as const) {
      expect(source, label).not.toContain('ADHD_AGENT_NATIVE_TOOLING_ENABLED');
      expect(source, label).not.toMatch(/\bNATIVE_TOOLING_ENABLED\b/);
    }

    // Negative control: the pattern HAS teeth — it matches a real, pre-existing
    // feature switch (`sse.enabled` → ADHD_AGENT_SSE_ENABLED), so a naive
    // implementation that named a new toggle `*_ENABLED` WOULD be caught.
    expect(FEATURE_SWITCH.test('ADHD_AGENT_SSE_ENABLED')).toBe(true);
  });

  it('AC4: grep proves `ephemeralAskPolicy` does NOT exist anywhere in the config surface', () => {
    const surface = [agentMcpSrc, baseSpecSrc].join('\n');
    expect(surface).not.toContain('ephemeralAskPolicy');
    expect(
      Object.keys(agentMcpEnvironmentSpec.config).some((k) => k.includes('ephemeralAskPolicy'))
    ).toBe(false);
    // Teeth: the same substring search DOES find a token that is present.
    expect(surface).toContain('nativeTooling');
  });

  it('AC2: neither changed file papers over the lint gate with a suppression directive', () => {
    for (const [label, source] of [
      ['config.ts', agentMcpSrc],
      ['environment-base-spec/src/index.ts', baseSpecSrc],
    ] as const) {
      expect(source, label).not.toMatch(/eslint-disable/);
      expect(source, label).not.toMatch(/@ts-ignore|@ts-nocheck|@ts-expect-error/);
    }
  });

  it('NAT-TOOL-7: the retired `ADHD_AGENT_SHELL_MCP_PATH` is absent from the config surface, and no shell MCP-path field is re-introduced', () => {
    const surface = [agentMcpSrc, baseSpecSrc].join('\n');
    expect(surface).not.toContain('ADHD_AGENT_SHELL_MCP_PATH');
    expect(
      Object.keys(agentMcpEnvironmentSpec.config).some((k) => /mcpPath|mcp_path|shellMcpPath/i.test(k))
    ).toBe(false);
  });

  it('NAT-TOOL-7: nativeTooling.hitl resolves to the ADR default (true) with zero files/env; fs.root stays unset (task-time root, D4)', () => {
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', undefined);
    try {
      const env = makeEnv(mkAdhdRoot(), mkCwdFixture(false));
      expect(env.config.nativeTooling.hitl).toBe(true);
      expect(env.get('provenance.nativeTooling.hitl')).toMatchObject({ source: 'default' });
      expect(env.config.nativeTooling.fs.root).toBeUndefined();
    } finally {
      restoreScope();
    }
  });

  // A1: the config surface must demonstrably CHANGE a dispatched agent's resolved
  // toolset — not merely reach `env.config`. Asserts the EFFECT end to end.
  it('A1: ADHD_AGENT_NATIVE_TOOLING_* changes a dispatched agent\'s resolved toolset + HITL', () => {
    const restoreHitl = withEnvVar('ADHD_AGENT_NATIVE_TOOLING_HITL', 'false');
    const restoreTools = withEnvVar(
      'ADHD_AGENT_NATIVE_TOOLING_DISPATCH_ALLOWED_TOOLS',
      'task,agent'
    );
    const restoreScope = withEnvVar('ADHD_ENV_SCOPE', undefined);
    try {
      const env = makeEnv(mkAdhdRoot(), mkCwdFixture(false));
      const dispatchSelf: McpServerConfig = {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@adhd/agent-mcp@latest'],
      };
      const ctx = {
        cwd: '/P',
        dispatchSelf,
        defaultNativeTooling: nativeToolingFromResolvedConfig(env.config.nativeTooling),
      };

      // The server-wide env values are now the EFFECTIVE toolset of an agent that
      // declares no nativeTooling of its own (A1 wiring).
      const resolved = withDefaultMcpServers({ mcpServers: {} }, ctx);
      expect(
        (resolved.mcpServers['agent-mcp'] as { allowedTools?: string[] }).allowedTools
      ).toEqual(['task', 'agent']);
      expect(effectiveHitl(resolved)).toBe(false);

      // NEGATIVE CONTROL: drop the server-wide layer → the SAME env vars have NO
      // effect (the resolved toolset is unconstrained, HITL is not pinned false).
      const bare = withDefaultMcpServers(
        { mcpServers: {} },
        { cwd: '/P', dispatchSelf }
      );
      expect(
        (bare.mcpServers['agent-mcp'] as { allowedTools?: string[] }).allowedTools
      ).toBeUndefined();
      expect(effectiveHitl(bare)).not.toBe(false);
    } finally {
      restoreScope();
      restoreTools();
      restoreHitl();
    }
  });
});
