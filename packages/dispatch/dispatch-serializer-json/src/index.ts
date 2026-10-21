import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { upgradeDagToCurrent } from '@adhd/dispatch-base-spec';
import type { DagJson, DagSnapshot } from '@adhd/dispatch-base-spec';
import type { IDagSerializer } from '@adhd/dispatch-core-client';

/**
 * Normalizes a DAG object, converting legacy object-based operations format to array format.
 * This ensures backward compatibility with older DAG files.
 */
export function normalizeDag(dag: DagJson): DagJson {
  if (Array.isArray(dag.operations)) return dag;
  return { ...dag, operations: Object.values(dag.operations) };
}

/**
 * Creates a JSON file-based DAG serializer with atomic writes and external change watching.
 * Uses temp-file + rename pattern for atomicity, ensuring no partial writes.
 */
export function createJsonFileSerializer(filePath: string): IDagSerializer {
  const dagPath = filePath.endsWith('.json') ? filePath : `${filePath}.dag.json`;
  const snapshotPath = filePath.endsWith('.json')
    ? filePath.replace(/\.json$/, '.snapshot.json')
    : `${filePath}.snapshot.json`;

  /**
   * Atomically writes data to a file using temp-file + rename pattern.
   *
   * The temp name carries the pid and a random suffix so two writers targeting
   * the same path never share a temp file. The temp file is removed in `finally`
   * so a failed write or rename leaves no `.tmp` behind (after a successful
   * rename the temp path no longer exists and the removal is a no-op).
   */
  function atomicWrite(targetPath: string, data: unknown): void {
    const dir = path.dirname(targetPath);
    const filename = path.basename(targetPath);
    const tempPath = path.join(dir, `.${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);

    try {
      // Write to temp file
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');

      // Atomic rename
      fs.renameSync(tempPath, targetPath);
    } finally {
      // Cleanup must not mask the primary error: a throwing rmSync here would
      // replace the write/rename failure that is already propagating.
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* best effort: the original error (if any) survives */
      }
    }
  }

  /**
   * Reads a JSON file, parsing it and applying normalization.
   */
  async function readDag(): Promise<DagJson | null> {
    try {
      const content = fs.readFileSync(dagPath, 'utf-8');
      const parsed = JSON.parse(content) as DagJson;
      // Older on-disk documents (e.g. v4 snake_case provider entries) are
      // upgraded to the current schema in place before anything reads them.
      upgradeDagToCurrent(parsed as unknown as Record<string, unknown>);
      return normalizeDag(parsed);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Writes a DAG atomically to the DAG file.
   */
  async function writeDag(dag: DagJson): Promise<void> {
    atomicWrite(dagPath, dag);
  }

  /**
   * Reads a snapshot file, returning null if it doesn't exist.
   */
  async function readSnapshot(): Promise<DagSnapshot | null> {
    try {
      const content = fs.readFileSync(snapshotPath, 'utf-8');
      return JSON.parse(content) as DagSnapshot;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Writes a snapshot atomically to the snapshot file.
   */
  async function writeSnapshot(snapshot: DagSnapshot): Promise<void> {
    atomicWrite(snapshotPath, snapshot);
  }

  return {
    readDag,
    writeDag,
    readSnapshot,
    writeSnapshot,
  };
}
