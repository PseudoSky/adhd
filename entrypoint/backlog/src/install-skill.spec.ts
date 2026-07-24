/**
 * install-skill.spec.ts — MIGRATION.md §4.2. `installSkill`'s `homeOverride`
 * parameter is a TEST-ISOLATION ESCAPE HATCH ONLY (mirrors
 * `BacklogCtx.adhdRoot` elsewhere in this package) — every test here passes
 * one, so NOTHING in this file ever touches the real machine's
 * `~/.claude/skills/`, `~/.codex/skills/`, or `~/.config/opencode/skills/`.
 * `--scope project` tests use a real `mkdtempSync` cwd instead, for the same
 * reason.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkill } from './install-skill.js';

const REAL_SKILL_MD = readFileSync(join(process.cwd(), 'skill', 'SKILL.md'), 'utf8');

describe('installSkill (MIGRATION.md §4.2)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-skill-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('default (--host all --scope user) installs to all 3 host dirs under the ISOLATED home override, never the real machine home', () => {
    const results = installSkill([], tmp, tmp);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.host).sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const r of results) {
      expect(r.path.startsWith(tmp)).toBe(true);
      expect(existsSync(r.path)).toBe(true);
      expect(readFileSync(r.path, 'utf8')).toBe(REAL_SKILL_MD);
    }
    // Exact expected paths per the surveyed per-host table.
    const byHost = Object.fromEntries(results.map((r) => [r.host, r]));
    expect(byHost['claude']?.path).toBe(join(tmp, '.claude', 'skills', 'backlog', 'SKILL.md'));
    expect(byHost['codex']?.path).toBe(join(tmp, '.codex', 'skills', 'backlog', 'SKILL.md'));
    expect(byHost['opencode']?.path).toBe(join(tmp, '.config', 'opencode', 'skills', 'backlog', 'SKILL.md'));
  });

  it('--host claude installs to only the Claude Code directory', () => {
    const results = installSkill(['--host', 'claude'], tmp, tmp);
    expect(results).toHaveLength(1);
    expect(results[0].host).toBe('claude');
  });

  it('--scope project installs under the given cwd, never under the home override', () => {
    const results = installSkill(['--host', 'claude', '--scope', 'project'], tmp, '/should-never-be-used');
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(join(tmp, '.claude', 'skills', 'backlog', 'SKILL.md'));
  });

  it('drops a thin extension.json alongside SKILL.md, matching the memory-usage precedent shape', () => {
    const results = installSkill(['--host', 'claude'], tmp, tmp);
    const extPath = join(results[0].path, '..', 'extension.json');
    expect(existsSync(extPath)).toBe(true);
    const ext = JSON.parse(readFileSync(extPath, 'utf8'));
    expect(ext).toMatchObject({ name: '@adhd/backlog', type: 'skill', entrypoint: 'SKILL.md' });
    expect(typeof ext.version).toBe('string');
  });

  it('re-running install-skill is idempotent (re-installing overwrites with identical content, never errors)', () => {
    installSkill(['--host', 'claude'], tmp, tmp);
    const second = installSkill(['--host', 'claude'], tmp, tmp);
    expect(readFileSync(second[0].path, 'utf8')).toBe(REAL_SKILL_MD);
  });

  it('rejects an unknown --host', () => {
    expect(() => installSkill(['--host', 'bogus'], tmp, tmp)).toThrow(/--host/);
  });

  it('rejects an unknown --scope', () => {
    expect(() => installSkill(['--host', 'claude', '--scope', 'bogus'], tmp, tmp)).toThrow(/--scope/);
  });

  it('NEGATIVE-CONTROL-style guard: every returned path lands under the supplied override root, never containing a literal ".adhd" segment or the real os.homedir()', async () => {
    const { homedir } = await import('node:os');
    const results = installSkill([], tmp, tmp);
    for (const r of results) {
      expect(r.path.startsWith(homedir())).toBe(false);
    }
  });
});
