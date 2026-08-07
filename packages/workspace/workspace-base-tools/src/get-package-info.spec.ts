import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceRoot } from '@nx/devkit';
import { getPackageInfo } from './get-package-info';

describe('getPackageInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('walks up from cwd to the nearest package.json and reports its name + root', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-')));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@test/pkg' }));
      const nested = path.join(root, 'src', 'deep', 'nested');
      fs.mkdirSync(nested, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(nested);

      const info = getPackageInfo();

      expect(info.packageName).toBe('@test/pkg');
      expect(fs.realpathSync(info.packageRoot)).toBe(root);
      expect(info.workspace).toBe(workspaceRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the directory name when the nearest package.json has no "name"', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-')));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const info = getPackageInfo();

      expect(info.packageName).toBe(path.basename(root));
      expect(fs.realpathSync(info.packageRoot)).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to workspace-root when no package.json exists above cwd', () => {
    // A nonexistent dir under tmpdir has no package.json anywhere up its walk —
    // real fs already returns false, no mock needed. (vi.spyOn(fs, 'existsSync')
    // also throws "Cannot redefine property" on Node 24: node: builtin namespace
    // exports are non-configurable.)
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'nope', 'deeper'));

    const info = getPackageInfo();

    expect(info.packageName).toBe('workspace-root');
    expect(info.packageRoot).toBe(workspaceRoot);
    expect(info.workspace).toBe(workspaceRoot);
  });

  it('is resilient to a malformed package.json (does not throw)', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wbt-')));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{ this is not json');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const info = getPackageInfo();

      // malformed parse breaks the walk → workspace-root fallback, never a throw
      expect(info.packageName).toBe('workspace-root');
      expect(info.workspace).toBe(workspaceRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
