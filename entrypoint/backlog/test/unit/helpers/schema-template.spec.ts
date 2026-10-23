/**
 * schema-template.spec.ts — qa-variance: the seeded-store helper never
 * replaces an existing store and yields a store the real openers accept.
 *
 * Real components: the real turso adapter and `openTestIssueStore` /
 * `openGraphBacklogStore` over files in a fresh temp directory. Nothing mocked.
 *
 * guards: a seeded store file overwrites a store a caller (or a child process) already created, or leaves a store the production opener rejects
 * tier: S
 * cites: qa-variance (docs/discovery/qa-test-variance-tail-policy-backlog-nx.md)
 * teeth: red: pending (verification pending, tests not run per user)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openGraphBacklogStore,
  closeGraphBacklogStore,
} from '../../../src/store/graph-backlog-store.js';
import { seedFromSchemaTemplate } from '../../helpers/schema-template.js';
import { freshTmpDir } from '../../helpers/tmp-store.js';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
} from '../../helpers/open-test-issue-store.js';

describe('seedFromSchemaTemplate', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshTmpDir('schema-template-spec');
  });
  afterEach(() => {
    removeTestIssueStoreDir(dir);
  });

  it('declines :memory: and leaves no file', async () => {
    expect(await seedFromSchemaTemplate(':memory:')).toBe(false);
  });

  it('seeds an absent path, leaves no staging file, and the production opener accepts it', async () => {
    const dbPath = join(dir, 'nested', 'backlog.db');
    expect(await seedFromSchemaTemplate(dbPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['backlog.db']);
    const store = await openGraphBacklogStore(dbPath);
    await closeGraphBacklogStore(store);
  });

  it('never replaces an existing path', async () => {
    const dbPath = join(dir, 'backlog.db');
    writeFileSync(dbPath, 'pre-existing bytes');
    expect(await seedFromSchemaTemplate(dbPath)).toBe(false);
    expect(readFileSync(dbPath, 'utf8')).toBe('pre-existing bytes');
  });

  it('two stores opened from the template are independent', async () => {
    const a = await openTestIssueStore(join(dir, 'a', 'backlog.db'));
    const b = await openTestIssueStore(join(dir, 'b', 'backlog.db'));
    try {
      const seeded = await seedProject(a, 'only-in-a');
      const { rows } = await b.adapter.executeAll<{ n: number }>(
        'SELECT count(*) AS n FROM node WHERE uid = ?',
        [seeded.projectUid]
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
