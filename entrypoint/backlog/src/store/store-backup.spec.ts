/**
 * store-backup.spec.ts — real-DB proof for `backupStore`/`restoreStore`
 * (P4): backs up a real store via a live `VACUUM INTO`, restores it to a
 * fresh path, OPENS the restored file as a real store, and asserts the data
 * that was written before the backup is actually there — not merely "a file
 * of the right size exists".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openTmpStore, freshTmpDir, type TmpStore } from '../test/helpers/tmp-store.js';
import { openGraphBacklogStore, closeGraphBacklogStore, type GraphBacklogStore } from './graph-backlog-store.js';
import { createItemNode } from './crud.js';
import { backupStore, restoreStore, BackupDestinationExistsError, BackupIntegrityError } from './store-backup.js';
import { readBackupManifest } from './backup-manifest.js';

describe('backupStore / restoreStore', () => {
  let tmp: TmpStore | undefined;
  let extraStores: GraphBacklogStore[] = [];
  let extraDirs: string[] = [];

  function trackedFreshTmpDir(name: string): string {
    const dir = freshTmpDir(name);
    extraDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const s of extraStores) await closeGraphBacklogStore(s);
    extraStores = [];
    if (tmp) await tmp.cleanup();
    tmp = undefined;
    for (const dir of extraDirs) rmSync(dir, { recursive: true, force: true });
    extraDirs = [];
  });

  it('backs up a real store, restores it to a fresh path, and the restored store contains the same item', async () => {
    tmp = await openTmpStore('backup-roundtrip');
    const created = await createItemNode(tmp.store, { repo: 'acme/widgets', family: 'BUG', title: 'Widget explodes', body: 'Steam everywhere.' });
    expect(created.created).toBe(true);
    const humanId = created.item.humanId;

    const backupDir = trackedFreshTmpDir('backup-dest');
    const backupPath = join(backupDir, 'snapshot.db');
    const backupResult = await backupStore(tmp.store, tmp.dbPath, backupPath);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(backupResult.manifestPath)).toBe(true);
    expect(backupResult.sizeBytes).toBeGreaterThan(0);

    const manifest = readBackupManifest(backupPath);
    expect(manifest.sha256).toBe(backupResult.sha256);
    expect(manifest.sourceDbPath).toBe(tmp.dbPath);

    // Dry run: verifies but writes nothing.
    const restoreDir = trackedFreshTmpDir('restore-dest');
    const destDbPath = join(restoreDir, 'restored.db');
    const preview = await restoreStore(backupPath, destDbPath, { confirm: false });
    expect(preview.restored).toBe(false);
    expect(existsSync(destDbPath)).toBe(false);

    // Confirmed restore.
    const result = await restoreStore(backupPath, destDbPath, { confirm: true });
    expect(result.restored).toBe(true);
    expect(existsSync(destDbPath)).toBe(true);

    // Open the RESTORED file as a real store and prove the item survived.
    const restoredStore = await openGraphBacklogStore(destDbPath);
    extraStores.push(restoredStore);
    const { rows } = await restoredStore.adapter.executeAll<{ meta: string }>(
      `SELECT meta FROM node WHERE json_extract(meta, '$.humanId') = ?`,
      [humanId]
    );
    expect(rows.length).toBe(1);
    const restoredMeta = JSON.parse(rows[0]!.meta) as { title: string };
    expect(restoredMeta.title).toBe('Widget explodes');
  });

  it('refuses to overwrite an existing backup destination without overwrite:true', async () => {
    tmp = await openTmpStore('backup-noclobber');
    await createItemNode(tmp.store, { repo: 'acme/widgets', family: 'BUG', title: 'x', body: 'y' });
    const dir = trackedFreshTmpDir('backup-dest-exists');
    const destPath = join(dir, 'snapshot.db');
    writeFileSync(destPath, 'not a real backup');

    let caught: unknown;
    try {
      await backupStore(tmp.store, tmp.dbPath, destPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackupDestinationExistsError);
    expect(readFileSync(destPath, 'utf8')).toBe('not a real backup'); // untouched

    // overwrite:true replaces it.
    const result = await backupStore(tmp.store, tmp.dbPath, destPath, { overwrite: true });
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('restore rejects a backup whose file bytes no longer match its manifest sha256 (corruption/tamper detection)', async () => {
    tmp = await openTmpStore('backup-corrupt');
    await createItemNode(tmp.store, { repo: 'acme/widgets', family: 'BUG', title: 'x', body: 'y' });
    const dir = trackedFreshTmpDir('backup-corrupt-dest');
    const backupPath = join(dir, 'snapshot.db');
    await backupStore(tmp.store, tmp.dbPath, backupPath);

    // Tamper with the backup file after the fact.
    const bytes = readFileSync(backupPath);
    writeFileSync(backupPath, Buffer.concat([bytes, Buffer.from('corruption')]));
    // Sanity: the manifest's recorded hash no longer matches.
    const manifest = readBackupManifest(backupPath);
    const actual = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
    expect(actual).not.toBe(manifest.sha256);

    let caught: unknown;
    try {
      await restoreStore(backupPath, join(dir, 'wont-be-written.db'), { confirm: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackupIntegrityError);
    expect(existsSync(join(dir, 'wont-be-written.db'))).toBe(false);
  });

  it('restore fails loudly (real Error, not a silent no-op) when the backup file does not exist', async () => {
    const dir = trackedFreshTmpDir('backup-missing');
    let caught: unknown;
    try {
      await restoreStore(join(dir, 'nope.db'), join(dir, 'dest.db'), { confirm: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('not found');
  });

});
