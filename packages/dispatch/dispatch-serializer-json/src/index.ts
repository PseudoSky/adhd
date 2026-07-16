import * as fs from 'fs';
import * as path from 'path';
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
   */
  function atomicWrite(targetPath: string, data: unknown): void {
    const dir = path.dirname(targetPath);
    const filename = path.basename(targetPath);
    const tempPath = path.join(dir, `.${filename}.tmp`);

    // Write to temp file
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');

    // Atomic rename
    fs.renameSync(tempPath, targetPath);
  }

  /**
   * Reads a JSON file, parsing it and applying normalization.
   */
  async function readDag(): Promise<DagJson | null> {
    try {
      const content = fs.readFileSync(dagPath, 'utf-8');
      const parsed = JSON.parse(content) as DagJson;
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
