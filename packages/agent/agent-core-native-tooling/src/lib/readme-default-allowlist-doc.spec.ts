/**
 * Docs contract for the default shell allowlist (069316e5 policy change; 61358b6f
 * follow-through). The README section "Default shell allowlist (ADR-0008 D5 policy
 * change)" must name the export, the override and `allowPatterns`-suppression rules,
 * the exclusions, and the server-rejected names; and the catalog must keep them
 * true. Reads the REAL README and the REAL catalog; no spawn.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SHELL_ALLOW_COMMANDS } from './catalog.js';

const README = readFileSync(join(__dirname, '../../README.md'), 'utf8');
const HEADING = '## Default shell allowlist (ADR-0008 D5 policy change)';

/** Names `mcp-shell-server==1.1.12` rejects under its default policy (`DANGEROUS_COMMANDS`, command_validator.py). */
const SERVER_REJECTED_1_1_12: readonly string[] = [
  'sh', 'bash', 'zsh', 'fish', 'csh', 'ksh', 'python', 'python3', 'perl', 'ruby', 'node', 'php', 'lua', 'env',
  'chroot', 'ex', 'flock', 'gdb', 'ionice', 'less', 'man', 'more', 'mysql', 'nice', 'nohup', 'pg', 'psql',
  'rsync', 'script', 'sed', 'setsid', 'sqlite3', 'ssh', 'stdbuf', 'taskset', 'time', 'timeout', 'unshare', 'vi',
  'view', 'vim', 'watch', 'xargs', 'zip',
];

function section(): string {
  const start = README.indexOf(HEADING);
  expect(start, `README is missing the heading "${HEADING}"`).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + HEADING.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('README documents the default shell allowlist', () => {
  it('names DEFAULT_SHELL_ALLOW_COMMANDS and the override rule (a caller list replaces it in full, never merged)', () => {
    const s = section();
    expect(s).toContain('DEFAULT_SHELL_ALLOW_COMMANDS');
    expect(s).toContain('allowCommands');
    expect(s).toMatch(/replaces? it in full/);
    expect(s).toMatch(/never merged/);
  });

  it('documents that a supplied allowPatterns suppresses the default', () => {
    const s = section();
    expect(s).toContain('allowPatterns');
    expect(s).toMatch(/suppress/i);
  });

  it('R5-WEB-SIMPLE AC1: README names curl as the one default network tool and every still-excluded tool', () => {
    const s = section();
    expect(s).toContain('`curl`');
    expect(DEFAULT_SHELL_ALLOW_COMMANDS).toContain('curl');
    for (const banned of ['wget', 'ssh', 'scp', 'sudo', 'nc']) {
      expect(s, banned).toContain(`\`${banned}\``);
      expect(DEFAULT_SHELL_ALLOW_COMMANDS).not.toContain(banned);
    }
  });

  it('documents the names the server rejects by policy and keeps them out of the default', () => {
    const s = section();
    for (const name of ['sed', 'node', 'python3']) expect(s, name).toContain(`\`${name}\``);
    expect(s).toMatch(/default security\s+policy/);
    expect(DEFAULT_SHELL_ALLOW_COMMANDS.filter((c) => SERVER_REJECTED_1_1_12.includes(c))).toEqual([]);
  });

  it('the exit-status shim section documents the trailer, the absolute-path gap and the protected set', () => {
    expect(README).toContain('[exit status: N]');
    expect(README).toMatch(/absolute path/);
    expect(README).toContain('ADHD_SHIM_ORIG_PATH');
    expect(README).toContain('EXIT_SHIM_PROTECTED');
  });
});
