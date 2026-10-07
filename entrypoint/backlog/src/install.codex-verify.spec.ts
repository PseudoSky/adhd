/**
 * install.codex-verify.spec.ts — 5fd61857 B-AC12: `install` for codex asserts the
 * written TOML contains the server entry, or else returns a non-`written`
 * status; `runInstallCommand` exits non-zero on a `failed` registration.
 *
 * Every case passes a `homeOverride` / mkdtemp dir, so the real
 * `~/.codex/config.toml` is never touched.
 *
 * Negative control (run once, restored): returning `status:'written'`
 * unconditionally (the pre-change behaviour) turns the read-only and
 * directory-in-the-way rows red.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKLOG_MCP_NPX_ARGS, install, runInstallCommand, upsertTomlTable, verifyCodexBacklogEntry } from './install.js';

const SOUND = upsertTomlTable('', 'mcp_servers.backlog', [
  'command = "npx"',
  `args = [${BACKLOG_MCP_NPX_ARGS.map((a) => JSON.stringify(a)).join(', ')}]`,
]);

describe('5fd61857 B-AC12 — codex install verifies what it wrote', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-codex-'));
  });
  afterEach(() => {
    // restore permissions so the directory can be removed
    try {
      chmodSync(join(tmp, '.codex'), 0o755);
    } catch {
      /* not created in this case */
    }
    rmSync(tmp, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('5fd61857 B-AC12 verifyCodexBacklogEntry accepts the written shape and names each defect', () => {
    expect(verifyCodexBacklogEntry(SOUND)).toBeUndefined();
    expect(verifyCodexBacklogEntry('')).toMatch(/missing/);
    expect(verifyCodexBacklogEntry('[mcp_servers.other]\ncommand = "npx"\n')).toMatch(/\[mcp_servers\.backlog\] table is missing/);
    expect(verifyCodexBacklogEntry('[mcp_servers.backlog]\nargs = ["-y"]\n')).toMatch(/no `command = "npx"`/);
    expect(verifyCodexBacklogEntry('[mcp_servers.backlog]\ncommand = "npx"\n')).toMatch(/no `args/);
    expect(verifyCodexBacklogEntry('[mcp_servers.backlog]\ncommand = "npx"\nargs = ["-y"]\n')).toMatch(/args is missing/);
    // a backlog entry in ANOTHER table's body does not count
    expect(verifyCodexBacklogEntry('[mcp_servers.backlog]\n[x]\ncommand = "npx"\nargs = ["-y"]\n')).toMatch(/no `command/);
  });

  it('5fd61857 B-AC12 a normal codex install reports written and the file contains the entry', () => {
    const r = install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
    expect(r.mcp[0]!.status).toBe('written');
    expect(verifyCodexBacklogEntry(readFileSync(join(tmp, '.codex', 'config.toml'), 'utf8'))).toBeUndefined();
  });

  it('5fd61857 B-AC12 an unwritable config directory is `failed`, never `written`', () => {
    expect(process.getuid?.()).not.toBe(0); // chmod cannot deny root: fail loudly rather than pass vacuously
    mkdirSync(join(tmp, '.codex'));
    chmodSync(join(tmp, '.codex'), 0o555);
    const r = install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
    expect(r.mcp[0]!.status).toBe('failed');
    expect(r.mcp[0]!.note).toMatch(/could not update the config/);
    expect(existsSync(join(tmp, '.codex', 'config.toml'))).toBe(false);
  });

  it('5fd61857 B-AC12 a directory where config.toml should be is `failed`', () => {
    mkdirSync(join(tmp, '.codex', 'config.toml'), { recursive: true });
    const r = install(['--host', 'codex', '--scope', 'user', '--mcp-only'], tmp, tmp);
    expect(r.mcp[0]!.status).toBe('failed');
  });

  it('5fd61857 B-AC12 runInstallCommand exits non-zero when a registration failed', async () => {
    mkdirSync(join(tmp, '.codex', 'config.toml'), { recursive: true });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    const home = process.env['HOME'];
    process.env['HOME'] = tmp;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runInstallCommand(['--host', 'codex', '--scope', 'user', '--mcp-only']);
      expect(process.exitCode).toBe(1);
      expect(String(log.mock.calls[0]![0])).toContain('"status":"failed"');
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      err.mockRestore();
      if (home === undefined) delete process.env['HOME'];
      else process.env['HOME'] = home;
    }
  });
});
