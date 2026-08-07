import { describe, expect, it } from 'vitest';
import { REQUIRED_FILES, REQUIRED_TARGETS, requiredFilesFor, requiredTargetsFor } from './required';

describe('requiredTargetsFor', () => {
  it('returns the base required targets for a project with no publish-gating tags', () => {
    expect(requiredTargetsFor(['domain:workspace', 'pkg-kind:base'])).toEqual([...REQUIRED_TARGETS]);
  });

  it('adds nx-release-publish when access:public is present', () => {
    const targets = requiredTargetsFor(['domain:workspace', 'access:public']);
    expect(targets).toContain('nx-release-publish');
    expect(targets).toEqual([...REQUIRED_TARGETS, 'nx-release-publish']);
  });

  it('adds nx-release-publish when publish:npm is present', () => {
    const targets = requiredTargetsFor(['domain:workspace', 'publish:npm']);
    expect(targets).toContain('nx-release-publish');
  });

  it('does not mutate the REQUIRED_TARGETS constant', () => {
    requiredTargetsFor(['access:public']);
    expect(REQUIRED_TARGETS).toEqual(['build', 'lint', 'test', 'typecheck', 'demo', 'verify']);
  });
});

describe('requiredFilesFor', () => {
  it('returns all required files regardless of tags', () => {
    expect(requiredFilesFor([])).toEqual([...REQUIRED_FILES]);
    expect(requiredFilesFor(['access:public'])).toEqual([...REQUIRED_FILES]);
  });
});
