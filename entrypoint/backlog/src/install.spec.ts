/**
 * install.spec.ts — `backlog install --mcp-only` (BUG-013 feature half).
 * `homeOverride` is a TEST-ISOLATION ESCAPE HATCH ONLY (same convention as
 * `install-skill.spec.ts`) — every test here passes one, so nothing in this
 * file ever touches the real machine's `~/.claude.json`,
 * `~/.config/opencode/opencode.json`, or `~/.codex/config.toml`. `--scope
 * project` tests use a real `mkdtempSync` cwd instead, for the same reason.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install, runInstallCommand, upsertTomlTable, BACKLOG_MCP_NPX_ARGS, INSTALL_HELP_TEXT } from './install.js';

describe('install --mcp-only (BUG-013)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-mcp-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('claude', () => {
    it('user scope writes ~/.claude.json mcpServers.backlog with the correct stdio/npx shape', () => {
      const result = install(['--host', 'claude', '--scope', 'user', '--mcp-only'], tmp, tmp);
      expect(result.skill).toEqual([]);
      expect(result.mcp).toHaveLength(1);
      const configPath = join(tmp, '.claude.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.mcpServers.backlog).toEqual({
        type: 'stdio',
        command: 'npx',
        args: [...BACKLOG_MCP_NPX_ARGS],
      });
    });

    it('project scope writes <cwd>/.mcp.json mcpServers.backlog', () => {
      const result = install(['--host', 'claude', '--scope', 'project', '--mcp-only'], tmp, '/should-never-be-used');
      const configPath = join(tmp, '.mcp.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.mcpServers.backlog.command).toBe('npx');
    });

    it('NON-CLOBBER: a pre-existing unrelated server entry + unrelated top-level keys survive untouched', () => {
      const configPath = join(tmp, '.claude.json');
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            numStartups: 42,
            mcpServers: {
              'agent-mcp': { type: 'stdio', command: 'node', args: ['x.js'] },
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      install(['--host', 'claude', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.numStartups).toBe(42);
      expect(doc.mcpServers['agent-mcp']).toEqual({ type: 'stdio', command: 'node', args: ['x.js'] });
      expect(doc.mcpServers.backlog.command).toBe('npx');
    });

    it('IDEMPOTENT: running twice never duplicates or corrupts the entry', () => {
      install(['--host', 'claude', '--scope', 'user', '--mcp-only'], tmp, tmp);
      install(['--host', 'claude', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const configPath = join(tmp, '.claude.json');
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(Object.keys(doc.mcpServers)).toEqual(['backlog']);
      expect(doc.mcpServers.backlog).toEqual({ type: 'stdio', command: 'npx', args: [...BACKLOG_MCP_NPX_ARGS] });
    });
  });

  describe('opencode', () => {
    it('user scope writes ~/.config/opencode/opencode.json mcp.backlog with the correct local/array shape', () => {
      const result = install(['--host', 'opencode', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const configPath = join(tmp, '.config', 'opencode', 'opencode.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc.mcp.backlog).toEqual({
        type: 'local',
        command: ['npx', ...BACKLOG_MCP_NPX_ARGS],
      });
    });

    it('project scope writes <cwd>/opencode.json mcp.backlog', () => {
      const result = install(['--host', 'opencode', '--scope', 'project', '--mcp-only'], tmp, '/should-never-be-used');
      const configPath = join(tmp, 'opencode.json');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(Array.isArray(doc.mcp.backlog.command)).toBe(true);
      expect(doc.mcp.backlog.type).toBe('local');
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
      install(['--host', 'opencode', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(doc['$schema']).toBe('https://opencode.ai/config.json');
      expect(doc.mcp.github).toEqual({ type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-github'] });
      expect(doc.mcp.backlog.type).toBe('local');
    });

    it('IDEMPOTENT: running twice never duplicates or corrupts the entry', () => {
      install(['--host', 'opencode', '--scope', 'user', '--mcp-only'], tmp, tmp);
      install(['--host', 'opencode', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const configPath = join(tmp, '.config', 'opencode', 'opencode.json');
      const doc = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(Object.keys(doc.mcp)).toEqual(['backlog']);
    });
  });

  describe('codex (best-effort TOML)', () => {
    it('user scope writes ~/.codex/config.toml [mcp_servers.backlog]', () => {
      const result = install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const configPath = join(tmp, '.codex', 'config.toml');
      expect(result.mcp[0]!.configPath).toBe(configPath);
      const text = readFileSync(configPath, 'utf8');
      expect(text).toContain('[mcp_servers.backlog]');
      expect(text).toContain('command = "npx"');
      expect(text).toContain('"-y", "@adhd/backlog@latest", "serve", "--transport", "mcp"');
    });

    it('NON-CLOBBER: a pre-existing unrelated table survives untouched, byte-for-byte outside our table', () => {
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
      install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const text = readFileSync(configPath, 'utf8');
      expect(text).toContain('[mcp_servers.other]');
      expect(text).toContain('command = "some-other-tool"');
      expect(text).toContain('[projects."/foo/bar"]');
      expect(text).toContain('trust_level = "trusted"');
      expect(text).toContain('[mcp_servers.backlog]');
    });

    it('IDEMPOTENT: running twice replaces (never duplicates) the [mcp_servers.backlog] table', () => {
      install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
      install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
      const configPath = join(tmp, '.codex', 'config.toml');
      const text = readFileSync(configPath, 'utf8');
      expect(text.match(/\[mcp_servers\.backlog\]/g)).toHaveLength(1);
    });
  });

  it('--skill-only never touches any MCP config', () => {
    install(['--host', 'all', '--scope', 'user', '--skill-only'], tmp, tmp);
    expect(existsSync(join(tmp, '.claude.json'))).toBe(false);
    expect(existsSync(join(tmp, '.config', 'opencode', 'opencode.json'))).toBe(false);
    expect(existsSync(join(tmp, '.codex', 'config.toml'))).toBe(false);
  });

  it('--mcp-only never touches any skill directory', () => {
    install(['--host', 'all', '--scope', 'user', '--mcp-only'], tmp, tmp);
    expect(existsSync(join(tmp, '.claude', 'skills', 'backlog'))).toBe(false);
    expect(existsSync(join(tmp, '.config', 'opencode', 'skills', 'backlog'))).toBe(false);
    expect(existsSync(join(tmp, '.codex', 'skills', 'backlog'))).toBe(false);
  });

  it('default (no --skill-only/--mcp-only) installs BOTH the skill and the MCP entry for every host', () => {
    const result = install(['--host', 'all', '--scope', 'user'], tmp, tmp);
    expect(result.skill).toHaveLength(3);
    expect(result.mcp).toHaveLength(3);
    expect(existsSync(join(tmp, '.claude.json'))).toBe(true);
    expect(existsSync(join(tmp, '.claude', 'skills', 'backlog', 'SKILL.md'))).toBe(true);
  });

  it('--skill-only and --mcp-only together is rejected', () => {
    expect(() => install(['--skill-only', '--mcp-only'], tmp, tmp)).toThrow(/mutually exclusive/);
  });

  it('rejects an unknown --host', () => {
    expect(() => install(['--host', 'bogus'], tmp, tmp)).toThrow(/--host/);
  });

  it('runInstallCommand --help prints usage and never touches the filesystem', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runInstallCommand(['--help']);
    expect(logSpy).toHaveBeenCalledWith(INSTALL_HELP_TEXT);
    logSpy.mockRestore();
    expect(existsSync(join(tmp, '.claude.json'))).toBe(false);
  });
});

describe('upsertTomlTable (pure helper)', () => {
  it('appends a new table to an empty document', () => {
    const out = upsertTomlTable('', 'mcp_servers.backlog', ['command = "npx"']);
    expect(out).toBe('[mcp_servers.backlog]\ncommand = "npx"\n');
  });

  it('appends a new table after existing content, separated by one blank line', () => {
    const out = upsertTomlTable('[a]\nb = 1\n', 'mcp_servers.backlog', ['command = "npx"']);
    expect(out).toBe('[a]\nb = 1\n\n[mcp_servers.backlog]\ncommand = "npx"\n');
  });

  it('replaces an existing table in place, leaving tables before and after untouched', () => {
    const input = ['[before]', 'x = 1', '', '[mcp_servers.backlog]', 'command = "old"', '', '[after]', 'y = 2', ''].join('\n');
    const out = upsertTomlTable(input, 'mcp_servers.backlog', ['command = "npx"', 'args = []']);
    expect(out).toBe(['[before]', 'x = 1', '', '[mcp_servers.backlog]', 'command = "npx"', 'args = []', '[after]', 'y = 2'].join('\n') + '\n');
  });

  it('re-running with identical content is idempotent (no growth, no duplication)', () => {
    const once = upsertTomlTable('', 'mcp_servers.backlog', ['command = "npx"']);
    const twice = upsertTomlTable(once, 'mcp_servers.backlog', ['command = "npx"']);
    expect(twice).toBe(once);
  });
});
