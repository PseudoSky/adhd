/**
 * checker.spec.ts — proves `checkProject` against REAL fixture directories
 * on the real filesystem (no mocked `fs`), per AGENTS.md §7's "prove the
 * consumer-visible outcome through real components" standard.
 *
 * Fixtures live under `tmp/workspace-base-standard/fixtures/` (this repo's
 * one canonical ephemeral-artifact root) and are created/removed per test.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProject } from './checker';
import { REQUIRED_TARGETS } from './required';

// vitest's cwd is THIS PROJECT's own root (packages/workspace/
// workspace-base-standard), not the repo root — walk up from this file's
// directory (src/) to the repo root so fixtures land under the repo's one
// canonical `tmp/` root, per AGENTS.md's ephemeral-artifact convention.
// A distinct leaf subdirectory (not shared with taxonomy.spec.ts /
// metadata.spec.ts's fixture roots) — vitest runs spec files in parallel,
// and a shared parent directory being both read and recursively removed by
// concurrent test files races (ENOTEMPTY).
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURES_ROOT = join(REPO_ROOT, 'tmp', 'workspace-base-standard', 'fixtures', 'checker');

/** A README body that is deliberately NOT the generator's placeholder text. */
const REAL_README = `# @adhd/fixture-project

A real, hand-written description of this fixture package — not the
generator placeholder.

## Public API

- \`doTheThing()\`
`;

const REAL_CHANGELOG = `# Changelog

## Unreleased

- Initial fixture scaffold.
`;

const REAL_CLAUDE = `# Fixture project agent notes

## Invariants

- This fixture never writes outside its own directory.
`;

const REAL_DEMO = `# Demo

Run \`node demo.js\` to see it work.
`;

const REAL_PLAYBOOK = `# Playbook

1. Pre-merge: run tests.
2. Post-merge: tag release.
`;

function makeTargets(): Record<string, unknown> {
  const targets: Record<string, unknown> = {};
  for (const t of REQUIRED_TARGETS) {
    targets[t] = {};
  }
  return targets;
}

/** Writes a complete, standards-satisfying fixture project directory. */
function buildCompleteFixture(dir: string, projectName: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ name: projectName, targets: makeTargets() }, null, 2)
  );
  writeFileSync(join(dir, 'README.md'), REAL_README);
  writeFileSync(join(dir, 'CHANGELOG.md'), REAL_CHANGELOG);
  writeFileSync(join(dir, 'CLAUDE.md'), REAL_CLAUDE);
  writeFileSync(join(dir, 'DEMO.md'), REAL_DEMO);
  writeFileSync(join(dir, 'PLAYBOOK.md'), REAL_PLAYBOOK);
}

describe('checkProject — real fixture directories', () => {
  afterEach(() => {
    // Bounded, deterministic cleanup — no fixture survives a test.
    if (existsSync(FIXTURES_ROOT)) {
      rmSync(FIXTURES_ROOT, { recursive: true });
    }
  });

  it('returns zero errors for a project with every required file + target present', () => {
    const dir = join(FIXTURES_ROOT, 'complete');
    buildCompleteFixture(dir, 'fixture-complete');

    const results = checkProject(dir, ['domain:workspace']);

    const errors = results.filter((r) => r.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('flags a project missing DEMO.md with exactly one error mentioning DEMO.md', () => {
    const dir = join(FIXTURES_ROOT, 'missing-demo');
    buildCompleteFixture(dir, 'fixture-missing-demo');
    rmSync(join(dir, 'DEMO.md'));

    const results = checkProject(dir, ['domain:workspace']);
    const errors = results.filter((r) => r.severity === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('DEMO.md');
    expect(errors[0].rule).toBe('required-file-present');
  });

  it('errors on a missing required target', () => {
    const dir = join(FIXTURES_ROOT, 'missing-target');
    mkdirSync(dir, { recursive: true });
    const targets = makeTargets();
    delete targets['typecheck'];
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'fixture-missing-target', targets }, null, 2));
    writeFileSync(join(dir, 'README.md'), REAL_README);
    writeFileSync(join(dir, 'CHANGELOG.md'), REAL_CHANGELOG);
    writeFileSync(join(dir, 'CLAUDE.md'), REAL_CLAUDE);
    writeFileSync(join(dir, 'DEMO.md'), REAL_DEMO);
    writeFileSync(join(dir, 'PLAYBOOK.md'), REAL_PLAYBOOK);

    const results = checkProject(dir, ['domain:workspace']);
    const errors = results.filter((r) => r.severity === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('typecheck');
    expect(errors[0].rule).toBe('required-target-present');
  });

  it('errors on a required section marker missing from an existing file', () => {
    const dir = join(FIXTURES_ROOT, 'missing-marker');
    buildCompleteFixture(dir, 'fixture-missing-marker');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\nNo unreleased heading here.\n');

    const results = checkProject(dir, ['domain:workspace']);
    const errors = results.filter((r) => r.severity === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('## Unreleased');
    expect(errors[0].rule).toBe('required-section-present');
  });

  it('errors on an empty PLAYBOOK.md (non-empty-content requirement)', () => {
    const dir = join(FIXTURES_ROOT, 'empty-playbook');
    buildCompleteFixture(dir, 'fixture-empty-playbook');
    writeFileSync(join(dir, 'PLAYBOOK.md'), '   \n  ');

    const results = checkProject(dir, ['domain:workspace']);
    const errors = results.filter((r) => r.severity === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('PLAYBOOK.md');
  });

  describe('placeholder detection', () => {
    it('warns in dev mode when README.md is still the unmodified generator placeholder', () => {
      const dir = join(FIXTURES_ROOT, 'placeholder-dev');
      buildCompleteFixture(dir, 'fixture-placeholder');
      writeFileSync(
        join(dir, 'README.md'),
        '# @adhd/fixture-placeholder\n\n> TODO: one-line description of `fixture-placeholder`.\n\n```bash\nnpm install @adhd/fixture-placeholder\n```\n'
      );

      const results = checkProject(dir, ['domain:workspace'], { mode: 'dev' });

      // README still has the '## Public API' marker missing (the placeholder
      // doesn't include it) AND the placeholder-match warning.
      const placeholderResults = results.filter((r) => r.rule === 'required-file-not-placeholder');
      expect(placeholderResults).toHaveLength(1);
      expect(placeholderResults[0].severity).toBe('warn');
    });

    it('errors in ci mode for the same unmodified placeholder', () => {
      const dir = join(FIXTURES_ROOT, 'placeholder-ci');
      buildCompleteFixture(dir, 'fixture-placeholder-ci');
      writeFileSync(
        join(dir, 'README.md'),
        '# @adhd/fixture-placeholder-ci\n\n> TODO: one-line description of `fixture-placeholder-ci`.\n\n```bash\nnpm install @adhd/fixture-placeholder-ci\n```\n'
      );

      const results = checkProject(dir, ['domain:workspace'], { mode: 'ci' });

      const placeholderResults = results.filter((r) => r.rule === 'required-file-not-placeholder');
      expect(placeholderResults).toHaveLength(1);
      expect(placeholderResults[0].severity).toBe('error');
    });
  });
});
