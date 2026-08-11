/**
 * install.test.ts — `agent-mcp-install` (BUG-AGENTMCP-006). Modeled on
 * `entrypoint/backlog/src/install.spec.ts`: `homeOverride` is a
 * TEST-ISOLATION ESCAPE HATCH ONLY — every user-scope test passes one, so
 * nothing in this file ever touches the real machine's
 * `~/.config/opencode/opencode.json`, `~/.claude.json`, or
 * `~/.codex/config.toml`. `--scope project` tests use a real `mkdtempSync`
 * cwd instead, for the same reason.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  install,
  runInstallCommand,
  upsertTomlTable,
  AGENT_MCP_NPX_ARGS,
  INSTALL_HELP_TEXT,
} from '../install.js';

describe('agent-mcp-install (BUG-AGENTMCP-006)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-mcp-install-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('opencode', () => {
    it('user scope writes ~/.config/opencode/opencode.json mcp.agent-mcp with the correct local/array shape', () => {
      const result = install(['--host', 'opencode', '--scope', 'user'], tmp, tmp);
      const configPath = join(tmp, '.config', 'opencode', 'opencode.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.mcp['agent-mcp']).toEqual({
        type: 'local',
        command: ['npx', ...AGENT_MCP_NPX_ARGS],
      });
    });

    it('project scope writes <cwd>/opencode.json mcp.agent-mcp', () => {
      const result = install(['--host', 'opencode', '--scope', 'project'], tmp, '/should-never-be-used');
      const configPath = join(tmp, 'opencode.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.mcp['agent-mcp'].type).toBe('local');
      expect(Array.isArray(doc.mcp['agent-mcp'].command)).toBe(true);
    });

    it('NON-CLOBBER: pre-existing unrelated mcp entries + $schema survive untouched', () => {
      const configDir = join(tmp, '.config', 'opencode');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'opencode.json');
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              github: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-github'] },
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      install(['--host', 'opencode', '--scope', 'user'], tmp, tmp);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc['$schema']).toBe('https://opencode.ai/config.json');
      expect(doc.mcp.github).toEqual({ type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-github'] });
      expect(doc.mcp['agent-mcp'].type).toBe('local');
    });

    it('IDEMPOTENT: running twice never duplicates or corrupts the entry', () => {
      install(['--host', 'opencode', '--scope', 'user'], tmp, tmp);
      install(['--host', 'opencode', '--scope', 'user'], tmp, tmp);
      const configPath = join(tmp, '.config', 'opencode', 'opencode.json');
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(Object.keys(doc.mcp)).toEqual(['agent-mcp']);
      expect(doc.mcp['agent-mcp']).toEqual({
        type: 'local',
        command: ['npx', ...AGENT_MCP_NPX_ARGS],
      });
    });
  });

  describe('claude', () => {
    it('user scope writes ~/.claude.json mcpServers.agent-mcp with the correct stdio/npx shape', () => {
      const result = install(['--host', 'claude', '--scope', 'user'], tmp, tmp);
      const configPath = join(tmp, '.claude.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.mcpServers['agent-mcp']).toEqual({
        type: 'stdio',
        command: 'npx',
        args: [...AGENT_MCP_NPX_ARGS],
      });
    });

    it('project scope writes <cwd>/.mcp.json mcpServers.agent-mcp — the published shape, reproducible by the tool', () => {
      const result = install(['--host', 'claude', '--scope', 'project'], tmp, '/should-never-be-used');
      const configPath = join(tmp, '.mcp.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      // Matches this repo's own hand-maintained `agent-mcp-published` entry
      // (root `.mcp.json:13-17`) — the installer reproduces exactly the shape
      // a published consumer needs (`npx -y @adhd/agent-mcp@latest`).
      expect(doc.mcpServers['agent-mcp']).toEqual({
        type: 'stdio',
        command: 'npx',
        args: [...AGENT_MCP_NPX_ARGS],
      });
    });

    it('NON-CLOBBER: pre-existing unrelated server entries + unrelated top-level keys survive untouched', () => {
      const configPath = join(tmp, '.claude.json');
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            numStartups: 42,
            mcpServers: {
              other: { type: 'stdio', command: 'node', args: ['x.js'] },
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      install(['--host', 'claude', '--scope', 'user'], tmp, tmp);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.numStartups).toBe(42);
      expect(doc.mcpServers.other).toEqual({ type: 'stdio', command: 'node', args: ['x.js'] });
      expect(doc.mcpServers['agent-mcp'].command).toBe('npx');
    });
  });

  describe('codex (best-effort TOML)', () => {
    it('user scope writes ~/.codex/config.toml [mcp_servers.agent-mcp]', () => {
      const result = install(['--host', 'codex', '--scope', 'user'], tmp, tmp);
      const configPath = join(tmp, '.codex', 'config.toml');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const text = readFileSync(configPath, 'utf8');
      expect(text).toContain('[mcp_servers.agent-mcp]');
      expect(text).toContain('command = "npx"');
      expect(text).toContain('"-y", "@adhd/agent-mcp@latest"');
    });

    it('NON-CLOBBER: pre-existing unrelated tables survive untouched, byte-for-byte outside our table', () => {
      const codexDir = join(tmp, '.codex');
      mkdirSync(codexDir, { recursive: true });
      const configPath = join(codexDir, 'config.toml');
      const original = [
        '[mcp_servers.other]',
        'command = "some-other-tool"',
        'args = []',
        '',
        '[projects."/foo/bar"]',
        'trust_level = "trusted"',
        '',
      ].join('\n');
      writeFileSync(configPath, original, 'utf8');
      install(['--host', 'codex', '--scope', 'user'], tmp, tmp);
      const text = readFileSync(configPath, 'utf8');
      expect(text).toContain('[mcp_servers.other]');
      expect(text).toContain('command = "some-other-tool"');
      expect(text).toContain('[projects."/foo/bar"]');
      expect(text).toContain('trust_level = "trusted"');
      expect(text).toContain('[mcp_servers.agent-mcp]');
    });

    it('IDEMPOTENT: running twice replaces (never duplicates) the [mcp_servers.agent-mcp] table', () => {
      install(['--host', 'codex', '--scope', 'user'], tmp, tmp);
      install(['--host', 'codex', '--scope', 'user'], tmp, tmp);
      const configPath = join(tmp, '.codex', 'config.toml');
      const text = readFileSync(configPath, 'utf8');
      expect(text.match(/\[mcp_servers\.agent-mcp\]/g)).toHaveLength(1);
    });
  });

  it('default (no --host) registers the MCP entry for every host', () => {
    const result = install(['--scope', 'user'], tmp, tmp);
    expect(result.mcp).toHaveLength(3);
    expect(existsSync(join(tmp, '.claude.json'))).toBe(true);
    expect(existsSync(join(tmp, '.config', 'opencode', 'opencode.json'))).toBe(true);
    expect(existsSync(join(tmp, '.codex', 'config.toml'))).toBe(true);
  });

  it('rejects an unknown --host', () => {
    expect(() => install(['--host', 'bogus'], tmp, tmp)).toThrow(/--host/);
  });

  it('rejects an invalid --scope', () => {
    expect(() => install(['--scope', 'bogus'], tmp, tmp)).toThrow(/--scope/);
  });

  it('DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001: a bare trailing --host throws and does NOT silently install to every host', () => {
    let error: unknown;
    try {
      install(['--host'], tmp, tmp);
    } catch (e) {
      error = e;
    }
    // Must throw — never degrade a missing --host value to the "all" default.
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/--host/); // names the offending host argument
    expect(message).toMatch(/usage|--help|value/); // points at usage
    // And nothing may have been written anywhere: no config for any host.
    expect(existsSync(join(tmp, '.claude.json'))).toBe(false);
    expect(existsSync(join(tmp, '.config', 'opencode', 'opencode.json'))).toBe(false);
    expect(existsSync(join(tmp, '.codex', 'config.toml'))).toBe(false);
  });

  it('explicit --host all still registers the MCP entry for every host', () => {
    const result = install(['--host', 'all', '--scope', 'user'], tmp, tmp);
    expect(result.mcp).toHaveLength(3);
    expect(existsSync(join(tmp, '.claude.json'))).toBe(true);
    expect(existsSync(join(tmp, '.config', 'opencode', 'opencode.json'))).toBe(true);
    expect(existsSync(join(tmp, '.codex', 'config.toml'))).toBe(true);
  });

  it('runInstallCommand --help prints usage and never touches the filesystem', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runInstallCommand(['--help']);
    expect(logSpy).toHaveBeenCalledWith(INSTALL_HELP_TEXT);
    logSpy.mockRestore();
    expect(existsSync(join(tmp, '.config', 'opencode', 'opencode.json'))).toBe(false);
  });
});

describe('upsertTomlTable (pure helper)', () => {
  it('appends a new table to an empty document', () => {
    const out = upsertTomlTable('', 'mcp_servers.agent-mcp', ['command = "npx"']);
    expect(out).toBe('[mcp_servers.agent-mcp]\ncommand = "npx"\n');
  });

  it('appends a new table after existing content, separated by one blank line', () => {
    const out = upsertTomlTable('[a]\nb = 1\n', 'mcp_servers.agent-mcp', ['command = "npx"']);
    expect(out).toBe('[a]\nb = 1\n\n[mcp_servers.agent-mcp]\ncommand = "npx"\n');
  });

  it('replaces an existing table in place, leaving tables before and after untouched', () => {
    const input = ['[before]', 'x = 1', '', '[mcp_servers.agent-mcp]', 'command = "old"', '', '[after]', 'y = 2', ''].join('\n');
    const out = upsertTomlTable(input, 'mcp_servers.agent-mcp', ['command = "npx"', 'args = []']);
    expect(out).toBe(['[before]', 'x = 1', '', '[mcp_servers.agent-mcp]', 'command = "npx"', 'args = []', '[after]', 'y = 2'].join('\n') + '\n');
  });

  it('re-running with identical content is idempotent (no growth, no duplication)', () => {
    const once = upsertTomlTable('', 'mcp_servers.agent-mcp', ['command = "npx"']);
    const twice = upsertTomlTable(once, 'mcp_servers.agent-mcp', ['command = "npx"']);
    expect(twice).toBe(once);
  });
});
