/**
 * env.spec.ts — SPEC.md §7 DoD clause 4: cross-repo scope isolation. Two real
 * `Environment` instances at `project` scope rooted at two different temp
 * directories (each with its own `.git`) confirm items created in one are
 * invisible via `get` from the other; a third instance at `global`
 * scope (rooted at a temp `adhdRoot`, standing in for `HOME`) confirms items
 * created via EITHER project instance are still not visible there — project
 * and global are separate stores, by construction (SPEC.md §3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBacklogEnv,
  resolveBacklogDbPath,
  resolveIrCacheFile,
} from './env.js';
import { osTmpDir } from './test/helpers/tmp-store.js';
import { seedProject } from './test/helpers/open-test-issue-store.js';
import { create, get, type BacklogCtx } from './api.js';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
  type GraphBacklogStore,
} from './store/graph-backlog-store.js';

function makeProjectDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function buildCtx(
  store: GraphBacklogStore,
  env: ReturnType<typeof buildBacklogEnv>
): BacklogCtx {
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

  afterEach(async () => {
    for (const store of stores) await closeGraphBacklogStore(store);
    for (const dir of [projectDirA, projectDirB, globalHomeDir])
      rmSync(dir, { recursive: true, force: true });
  });

  async function openProjectCtx(projectDir: string): Promise<BacklogCtx> {
    const env = buildBacklogEnv({
      scope: 'project',
      cwd: projectDir,
      adhdRoot: projectDir,
    });
    env.ensureDirs();
    const store = await openGraphBacklogStore(env.files.db);
    stores.push(store);
    return buildCtx(store, env);
  }

  async function openGlobalCtx(adhdRoot: string): Promise<BacklogCtx> {
    const env = buildBacklogEnv({ scope: 'global', adhdRoot });
    env.ensureDirs();
    const store = await openGraphBacklogStore(env.files.db);
    stores.push(store);
    return buildCtx(store, env);
  }

  it("two project-scoped stores rooted at different directories never see each other's items", async () => {
    const ctxA = await openProjectCtx(projectDirA);
    const ctxB = await openProjectCtx(projectDirB);
    expect(ctxA.env.files.db).not.toBe(ctxB.env.files.db);

    const { projectUid } = await seedProject(ctxA.store, 'proj-isolate-a');
    const created = await create(ctxA, {
      project: projectUid,
      title: 'only in A',
      body: 'x',
      by: 'filer',
    });
    if (!created.ok)
      throw new Error(`expected create to succeed: ${created.error.message}`);
    const uid = created.data.uid;
    if (uid === undefined)
      throw new Error('expected created.data.uid to be set');

    const fromA = await get(ctxA, { uid });
    const fromB = await get(ctxB, { uid });

    expect(fromA.ok).toBe(true);
    expect(fromB.ok).toBe(false);
    if (!fromB.ok) expect(fromB.error.code).toBe('item_not_found');
  });

  it('a global-scoped store cannot see items created via either project-scoped instance', async () => {
    const ctxA = await openProjectCtx(projectDirA);
    const ctxB = await openProjectCtx(projectDirB);
    const ctxGlobal = await openGlobalCtx(globalHomeDir);

    expect(ctxGlobal.env.files.db).not.toBe(ctxA.env.files.db);
    expect(ctxGlobal.env.files.db).not.toBe(ctxB.env.files.db);

    const { projectUid: projectUidA } = await seedProject(
      ctxA.store,
      'proj-isolate-g-a'
    );
    const { projectUid: projectUidB } = await seedProject(
      ctxB.store,
      'proj-isolate-g-b'
    );

    const createdA = await create(ctxA, {
      project: projectUidA,
      title: 'from A',
      body: 'x',
      by: 'filer',
    });
    const createdB = await create(ctxB, {
      project: projectUidB,
      title: 'from B',
      body: 'x',
      by: 'filer',
    });
    if (!createdA.ok)
      throw new Error(
        `expected create A to succeed: ${createdA.error.message}`
      );
    if (!createdB.ok)
      throw new Error(
        `expected create B to succeed: ${createdB.error.message}`
      );
    const uidA = createdA.data.uid;
    const uidB = createdB.data.uid;
    if (uidA === undefined || uidB === undefined)
      throw new Error('expected created.data.uid to be set on both');

    const seenFromGlobalA = await get(ctxGlobal, { uid: uidA });
    const seenFromGlobalB = await get(ctxGlobal, { uid: uidB });
    expect(seenFromGlobalA.ok).toBe(false);
    expect(seenFromGlobalB.ok).toBe(false);
    if (!seenFromGlobalA.ok)
      expect(seenFromGlobalA.error.code).toBe('item_not_found');
    if (!seenFromGlobalB.ok)
      expect(seenFromGlobalB.error.code).toBe('item_not_found');
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

  it('db.busyTimeoutMs defaults to 5000 and is overridable via ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001)', async () => {
    const prev = process.env['ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS'];
    try {
      delete process.env['ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS'];
      const defaultEnv = buildBacklogEnv({
        scope: 'project',
        adhdRoot: projectDirA,
      });
      expect(defaultEnv.config.db.busyTimeoutMs).toBe(5000);

      process.env['ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS'] = '12345';
      const overriddenEnv = buildBacklogEnv({
        scope: 'project',
        adhdRoot: projectDirB,
      });
      expect(overriddenEnv.config.db.busyTimeoutMs).toBe(12345);
    } finally {
      if (prev === undefined)
        delete process.env['ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS'];
      else process.env['ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS'] = prev;
    }
  });

  it('BUG-002: ADHD_BACKLOG_DATABASE_PATH wins over the scope-root fallback in resolveBacklogDbPath — and unset still falls back to files.db', async () => {
    const prev = process.env['ADHD_BACKLOG_DATABASE_PATH'];
    try {
      const scratchDir = mkdtempSync(join(tmpdir(), 'backlog-env-dbpath-'));
      const scratchDb = join(scratchDir, 'scratch.db');

      process.env['ADHD_BACKLOG_DATABASE_PATH'] = scratchDb;
      const redirected = buildBacklogEnv({
        scope: 'global',
        adhdRoot: globalHomeDir,
      });
      // The Environment surfaces the env var as config.db.path (proving the
      // declared env→config binding works)…
      expect(redirected.config.db.path).toBe(scratchDb);
      // …and resolveBacklogDbPath returns it over the scope-root file.
      expect(resolveBacklogDbPath(redirected)).toBe(scratchDb);

      // Unset ⇒ falls back to files.db under the resolved scope root — the
      // exact behavior the FieldSpec description promises ("Unset ⇒ falls
      // back to env.files.db under the resolved scope root").
      delete process.env['ADHD_BACKLOG_DATABASE_PATH'];
      const fallback = buildBacklogEnv({
        scope: 'global',
        adhdRoot: globalHomeDir,
      });
      expect(fallback.config.db.path).toBeUndefined();
      expect(resolveBacklogDbPath(fallback)).toBe(fallback.files.db);

      rmSync(scratchDir, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env['ADHD_BACKLOG_DATABASE_PATH'];
      else process.env['ADHD_BACKLOG_DATABASE_PATH'] = prev;
    }
  });

  describe('BUG-CACHE-CWD-001 — resolveIrCacheFile is process.cwd()-independent', () => {
    let prevCwd: string;
    let prevEnvFile: string | undefined;

    beforeEach(() => {
      prevCwd = process.cwd();
      prevEnvFile = process.env['APIGEN_IR_CACHE_FILE'];
      delete process.env['APIGEN_IR_CACHE_FILE'];
    });

    afterEach(() => {
      process.chdir(prevCwd);
      if (prevEnvFile === undefined) delete process.env['APIGEN_IR_CACHE_FILE'];
      else process.env['APIGEN_IR_CACHE_FILE'] = prevEnvFile;
    });

    it("resolves to the SAME absolute path from two different cwds under the same adhdRoot (regression: the old default was `join(process.cwd(), 'tmp', 'apigen', 'ir-cache', ...)`, a fresh cache — and directory — per invocation cwd)", () => {
      const adhdRoot = globalHomeDir;
      const cwdA = osTmpDir('backlog-ir-cache-cwd-a');
      const cwdB = osTmpDir('backlog-ir-cache-cwd-b');

      process.chdir(cwdA);
      const pathFromA = resolveIrCacheFile({ adhdRoot });

      process.chdir(cwdB);
      const pathFromB = resolveIrCacheFile({ adhdRoot });

      expect(pathFromA).toBe(pathFromB);
      expect(pathFromA.startsWith(cwdA)).toBe(false);
      expect(pathFromA.startsWith(cwdB)).toBe(false);
      expect(pathFromA.startsWith(adhdRoot)).toBe(true);
      expect(
        pathFromA.endsWith(join('apigen', 'ir-cache', 'backlog-client.ir.json'))
      ).toBe(true);

      rmSync(cwdA, { recursive: true, force: true });
      rmSync(cwdB, { recursive: true, force: true });
    });

    it('is also independent of the caller-requested scope (project vs global) — the IR cache stays one machine-wide location regardless of ADHD_BACKLOG_SCOPE', () => {
      const adhdRoot = globalHomeDir;
      const prevScope = process.env['ADHD_BACKLOG_SCOPE'];
      try {
        process.env['ADHD_BACKLOG_SCOPE'] = 'project';
        const withProjectScopeEnvVar = resolveIrCacheFile({ adhdRoot });

        delete process.env['ADHD_BACKLOG_SCOPE'];
        const withNoScopeOverride = resolveIrCacheFile({ adhdRoot });

        expect(withProjectScopeEnvVar).toBe(withNoScopeOverride);
      } finally {
        if (prevScope === undefined) delete process.env['ADHD_BACKLOG_SCOPE'];
        else process.env['ADHD_BACKLOG_SCOPE'] = prevScope;
      }
    });

    it('APIGEN_IR_CACHE_FILE still wins outright over the resolved default (test-isolation escape hatch preserved)', () => {
      const override = join(
        osTmpDir('backlog-ir-cache-override'),
        'custom.ir.json'
      );
      process.env['APIGEN_IR_CACHE_FILE'] = override;
      expect(resolveIrCacheFile({ adhdRoot: globalHomeDir })).toBe(override);
    });
  });
});
