import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPolicyClient } from '../../index';
import { layer, WORKSPACE_DOCUMENT, WORKSPACE_POLICY } from '../helpers/policies';
import { withTmpDir } from '../helpers/tmp';

/** A real scratch directory with the demo's files in it. */
async function withDemo<T>(fn: (demo: string) => Promise<T>): Promise<T> {
  return withTmpDir('s1', async (demo) => {
    for (const file of ['work/readme.md', 'work/.env', 'work/out/notes.txt']) {
      await mkdir(dirname(join(demo, file)), { recursive: true });
      await writeFile(join(demo, file), 'x');
    }
    return fn(demo);
  });
}

describe('Feature: Library first - compile once, decide in process, no server', () => {
  it('@S1.1 importing the package starts nothing and exports the operations', async () => {
    vi.resetModules();
    const before = process.getActiveResourcesInfo().sort();
    const mod = await import('../../index');
    await Promise.resolve();
    const after = process.getActiveResourcesInfo().sort();
    for (const name of ['compile', 'evaluate', 'explain', 'narrow', 'resolve', 'verify', 'draft', 'createDecider']) {
      expect(typeof (mod as Record<string, unknown>)[name], name).toBe('function');
    }
    // No timer, socket, child process or immediate was added by loading the module.
    expect(after).toEqual(before);
  });

  it('@S1.2 an allowed read, and an allowed write with a forced value', async () => {
    await withDemo(async (demo) => {
      const client = createPolicyClient({ layers: WORKSPACE_POLICY });
      const attributes = { role: 'dev', read_roots: [`${demo}/work`] };

      const read = await client.evaluate({ tool: 'files.read', args: { path: `${demo}/work/readme.md` }, attributes });
      expect(read.effect).toBe('allow');
      expect(read.matched).toEqual(['project:0']);

      const write = await client.evaluate({ tool: 'files.write', args: { path: `${demo}/work/out/notes.txt` }, attributes });
      expect(write.effect).toBe('allow');
      expect(write.set).toEqual({ overwrite: false });
    });
  });

  it('@S1.2 a caller without the developer role gets the guest default and cannot write', async () => {
    await withDemo(async (demo) => {
      const client = createPolicyClient({ layers: WORKSPACE_POLICY });
      const decision = await client.evaluate({
        tool: 'files.write',
        args: { path: `${demo}/work/out/notes.txt` },
        attributes: { read_roots: [`${demo}/work`] },
      });
      expect(decision.effect).toBe('deny');
      expect(decision.denial?.code).toBe('no-match');
      expect(decision.set).toEqual({});
    });
  });

  it('@S1.2 a secret path is denied even inside the developers read root', async () => {
    await withDemo(async (demo) => {
      const attributes = { role: 'dev', read_roots: [`${demo}/work`] };
      const secret = { tool: 'files.read', args: { path: `${demo}/work/.env` }, attributes };

      const denied = await createPolicyClient({ layers: WORKSPACE_POLICY }).evaluate(secret);
      expect(denied.effect).toBe('deny');
      expect(denied.denial?.code).toBe('explicit-deny');
      expect(denied.matched).toEqual(['project:0', 'project:1']);

      // Negative control inside the test: the same call without the deny permission is allowed.
      const withoutDeny = {
        ...WORKSPACE_DOCUMENT,
        permissions: (WORKSPACE_DOCUMENT.permissions as readonly { effect?: string }[]).filter((permission) => permission.effect !== 'deny'),
      };
      const allowed = await createPolicyClient({ layers: [layer('project', withoutDeny)] }).evaluate(secret);
      expect(allowed.effect).toBe('allow');
    });
  });

  it('@S1.3 compiling is deterministic and the result is plain data', async () => {
    const client = createPolicyClient({ layers: [layer('project', { version: 1, permissions: [{ tool: 'a.b' }] })] });
    const first = await client.compile();
    const second = await client.compile();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.policy?.schemaVersion).toBe(1);
    // Plain data: it survives a JSON round trip unchanged.
    expect(JSON.parse(JSON.stringify(first.policy))).toEqual(first.policy);

    // A different document hashes differently (the hash is a function of the content).
    const other = await createPolicyClient({ layers: [layer('project', { version: 1, permissions: [{ tool: 'a.c' }] })] }).compile();
    expect(other.contentHash).not.toBe(first.contentHash);
  });
});
