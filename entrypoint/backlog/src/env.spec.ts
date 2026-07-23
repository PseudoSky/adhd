/**
 * env.spec.ts — SPEC.md §7 DoD clause 4: cross-repo scope isolation. Two real
 * `Environment` instances at `project` scope rooted at two different temp
 * directories (each with its own `.git`) confirm items created in one are
 * invisible via `listItems` from the other; a third instance at `global`
 * scope (rooted at a temp `adhdRoot`, standing in for `HOME`) confirms items
 * created via EITHER project instance are still not visible there — project
 * and global are separate SQLite files, by construction (SPEC.md §3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBacklogEnv } from './env.js';
import { createItem, getItem } from './client.js';
import type { BacklogCtx } from './client.js';
import { openGraphBacklogStore, closeGraphBacklogStore, type GraphBacklogStore } from './store/graph-backlog-store.js';

function makeProjectDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function buildCtx(store: GraphBacklogStore, env: ReturnType<typeof buildBacklogEnv>): BacklogCtx {
  return { store, env };
}

describe('scope isolation — real Environment instances, real temp filesystem roots', () => {
  let projectDirA: string;
  let projectDirB: string;
  let globalHomeDir: string;
  let stores: GraphBacklogStore[];

  beforeEach(() => {
    projectDirA = makeProjectDir('backlog-env-project-a');
    projectDirB = makeProjectDir('backlog-env-project-b');
    globalHomeDir = mkdtempSync(join(tmpdir(), 'backlog-env-global-'));
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) closeGraphBacklogStore(store);
    for (const dir of [projectDirA, projectDirB, globalHomeDir]) rmSync(dir, { recursive: true, force: true });
  });

  function openProjectCtx(projectDir: string): BacklogCtx {
    const env = buildBacklogEnv({ scope: 'project', cwd: projectDir, adhdRoot: projectDir });
    env.ensureDirs();
    const store = openGraphBacklogStore(env.files.db);
    stores.push(store);
    return buildCtx(store, env);
  }

  function openGlobalCtx(adhdRoot: string): BacklogCtx {
    const env = buildBacklogEnv({ scope: 'global', adhdRoot });
    env.ensureDirs();
    const store = openGraphBacklogStore(env.files.db);
    stores.push(store);
    return buildCtx(store, env);
  }

  it('two project-scoped stores rooted at different directories never see each other\'s items', async () => {
    const ctxA = openProjectCtx(projectDirA);
    const ctxB = openProjectCtx(projectDirB);
    expect(ctxA.env.files.db).not.toBe(ctxB.env.files.db);

    const created = await createItem(ctxA, { family: 'BUG-ISOLATE', title: 'only in A', body: 'x', repo: 'test/repo' });
    const fromA = await getItem(ctxA, 'test/repo', created.item.humanId);
    const fromB = await getItem(ctxB, 'test/repo', created.item.humanId);

    expect(fromA).not.toBeNull();
    expect(fromB).toBeNull();
  });

  it('a global-scoped store cannot see items created via either project-scoped instance', async () => {
    const ctxA = openProjectCtx(projectDirA);
    const ctxB = openProjectCtx(projectDirB);
    const ctxGlobal = openGlobalCtx(globalHomeDir);

    expect(ctxGlobal.env.files.db).not.toBe(ctxA.env.files.db);
    expect(ctxGlobal.env.files.db).not.toBe(ctxB.env.files.db);

    const createdA = await createItem(ctxA, { family: 'BUG-ISOLATE-G', title: 'from A', body: 'x', repo: 'test/repo' });
    const createdB = await createItem(ctxB, { family: 'BUG-ISOLATE-G', title: 'from B', body: 'x', repo: 'test/repo' });

    const seenFromGlobalA = await getItem(ctxGlobal, 'test/repo', createdA.item.humanId);
    const seenFromGlobalB = await getItem(ctxGlobal, 'test/repo', createdB.item.humanId);
    expect(seenFromGlobalA).toBeNull();
    expect(seenFromGlobalB).toBeNull();
  });

  it('resolveBacklogScope precedence: explicit option wins over ADHD_BACKLOG_SCOPE wins over ADHD_ENV_SCOPE wins over default global', async () => {
    const { resolveBacklogScope } = await import('./env.js');
    const prevBacklog = process.env['ADHD_BACKLOG_SCOPE'];
    const prevGeneric = process.env['ADHD_ENV_SCOPE'];
    try {
      delete process.env['ADHD_BACKLOG_SCOPE'];
      delete process.env['ADHD_ENV_SCOPE'];
      expect(resolveBacklogScope()).toBe('global');

      process.env['ADHD_ENV_SCOPE'] = 'system';
      expect(resolveBacklogScope()).toBe('system');

      process.env['ADHD_BACKLOG_SCOPE'] = 'project';
      expect(resolveBacklogScope()).toBe('project');

      expect(resolveBacklogScope('global')).toBe('global');
    } finally {
      if (prevBacklog === undefined) delete process.env['ADHD_BACKLOG_SCOPE'];
      else process.env['ADHD_BACKLOG_SCOPE'] = prevBacklog;
      if (prevGeneric === undefined) delete process.env['ADHD_ENV_SCOPE'];
      else process.env['ADHD_ENV_SCOPE'] = prevGeneric;
    }
  });
});
