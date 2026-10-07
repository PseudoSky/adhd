/**
 * install-skill.precondition.spec.ts — 5fd61857 B-AC12: `install-skill` refuses
 * a write when its precondition fails (an empty packaged skill, an unwritable
 * target) and verifies what it wrote; nothing is left half-installed.
 *
 * Every case passes a `homeOverride`, so the real `~/.claude/skills` is never
 * touched.
 *
 * Negative control (run once, restored): reverting to the unconditional write
 * turns the empty-source row red (an empty SKILL.md is installed as success).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSkillToHosts } from './install-skill.js';

describe('5fd61857 B-AC12 — install-skill preconditions', () => {
  let tmp: string;
  let source: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-skill-pre-'));
    source = join(tmp, 'SOURCE.md');
  });
  afterEach(() => {
    try {
      chmodSync(join(tmp, '.claude'), 0o755);
    } catch {
      /* not created in this case */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('5fd61857 B-AC12 an empty packaged skill is refused and nothing is written', () => {
    writeFileSync(source, '   \n\n', 'utf8');
    expect(() => installSkillToHosts(['claude'], 'user', tmp, tmp, source)).toThrow(/empty/);
    expect(existsSync(join(tmp, '.claude'))).toBe(false);
  });

  it('5fd61857 B-AC12 a missing packaged skill is refused', () => {
    expect(() => installSkillToHosts(['claude'], 'user', tmp, tmp, join(tmp, 'nope.md'))).toThrow(/not found/);
    expect(existsSync(join(tmp, '.claude'))).toBe(false);
  });

  it('5fd61857 B-AC12 a sound source installs byte-for-byte and the result path exists', () => {
    const body = '# backlog skill\n\nbody ✓\n';
    writeFileSync(source, body, 'utf8');
    const [r] = installSkillToHosts(['claude'], 'user', tmp, tmp, source);
    expect(readFileSync(r!.path, 'utf8')).toBe(body);
  });

  it('5fd61857 B-AC12 an unwritable target refuses (throws) and leaves no SKILL.md', () => {
    expect(process.getuid?.()).not.toBe(0); // chmod cannot deny root: fail loudly rather than pass vacuously
    writeFileSync(source, '# skill\n', 'utf8');
    mkdirSync(join(tmp, '.claude'));
    chmodSync(join(tmp, '.claude'), 0o555);
    expect(() => installSkillToHosts(['claude'], 'user', tmp, tmp, source)).toThrow();
    expect(existsSync(join(tmp, '.claude', 'skills', 'backlog', 'SKILL.md'))).toBe(false);
  });
});
