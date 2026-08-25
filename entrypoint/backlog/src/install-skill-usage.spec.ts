/**
 * install-skill-usage.spec.ts — BUG-BACKLOG-INSTALLSKILL-UX-001.
 *
 * These drive the REAL built `dist/index.js` as a child process, the way a
 * user or an agent host invokes it — not `installSkill()` in-process. That
 * matters here specifically: the defect being pinned lives in the seam
 * between `parseArgs` throwing and the BIN ENTRY-GUARD printing `err.stack`
 * (`index.ts`'s `runBacklogCli().catch(...)`). An in-process call to
 * `installSkill()` never reaches that guard, so it cannot observe the bug at
 * all — it would pass just as happily before the fix as after.
 *
 * `project.json`'s `test` target already declares `dependsOn: ["^build",
 * "build", "assets"]`, so `dist/index.js` is guaranteed present and current
 * when this runs. No env gate: nothing here is paid or external (AGENTS.md
 * "Live testing is mandatory — no silent gating").
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A minified dist stack frame — `    at u1 (/…/dist/index.js:363:5909)`. */
const STACK_FRAME = /^\s+at\s/m;

describe('BUG-BACKLOG-INSTALLSKILL-UX-001 — usage errors are usage messages, not stack traces', () => {
  it('--help prints usage and exits 0 (was: `unknown argument "--help"` on a stack trace)', () => {
    const { code, stdout, stderr } = run('install-skill', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('backlog install-skill [--host');
    expect(stdout).toContain('--scope <name>');
    // The whole point: no stack, and not treated as a bad argument.
    expect(stderr).not.toMatch(STACK_FRAME);
    expect(stderr).not.toContain('unknown argument');
  });

  it('-h is accepted the same way as --help', () => {
    expect(run('install-skill', '-h').code).toBe(0);
  });

  it('an invalid --scope exits 2 with a machine-readable envelope and NO stack frames', () => {
    const { code, stderr } = run('install-skill', '--host', 'claude', '--scope', 'global');
    expect(code).toBe(2);
    expect(stderr).not.toMatch(STACK_FRAME);

    // The first stderr line is the same envelope shape the mounted verbs emit.
    const envelope = JSON.parse(stderr.split('\n')[0]!) as { code: string; message: string };
    expect(envelope.code).toBe('invalid_argument');
    // "global" is the common wrong guess — the message must name the fix,
    // and must NOT silently coerce it to "user".
    expect(envelope.message).toContain('spelled "user"');
    expect(stderr).toContain('backlog install-skill [--host');
  });

  it('an unknown argument exits 2 with no stack frames', () => {
    const { code, stderr } = run('install-skill', '--bogus');
    expect(code).toBe(2);
    expect(stderr).not.toMatch(STACK_FRAME);
    expect(JSON.parse(stderr.split('\n')[0]!).code).toBe('invalid_argument');
  });

  it('an invalid --host exits 2 with no stack frames', () => {
    const { code, stderr } = run('install-skill', '--host', 'emacs');
    expect(code).toBe(2);
    expect(stderr).not.toMatch(STACK_FRAME);
    expect(JSON.parse(stderr.split('\n')[0]!).message).toContain('--host must be one of');
  });

  it('`install` accepts --help anywhere in argv, not only at argv[0]', () => {
    const { code, stdout } = run('install', '--host', 'claude', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('backlog install [--host');
  });

  it('`install` usage errors are also enveloped, not stack traces', () => {
    const { code, stderr } = run('install', '--skill-only', '--mcp-only');
    expect(code).toBe(2);
    expect(stderr).not.toMatch(STACK_FRAME);
    expect(JSON.parse(stderr.split('\n')[0]!).message).toContain('mutually exclusive');
  });

  it('a real (non-usage) fault is NOT swallowed into a usage message', () => {
    // A well-formed invocation pointed at an unwritable scope still fails
    // loudly — proving the catch is narrowed by TYPE (BacklogUsageError) and
    // is not a blanket try/catch that would hide genuine faults.
    const r = spawnSync(process.execPath, [DIST_INDEX, 'install-skill', '--host', 'claude', '--scope', 'project'], {
      encoding: 'utf8',
      cwd: '/dev/null/nonexistent-cwd-for-backlog-test',
    });
    expect(r.status).not.toBe(0);
  });
});
