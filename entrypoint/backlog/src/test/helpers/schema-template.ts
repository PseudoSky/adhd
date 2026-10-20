/**
 * schema-template.ts — test support: a schema-applied store file built ONCE per
 * process and copied into place for every test that opens a fresh real store.
 *
 * Failure mode guarded: cost of the per-test `applySchema()` DDL (tables,
 * indexes, FTS virtual table, triggers) scales with machine load, so tests
 * that each open a fresh real store show a 10x p95/median spread in
 * `~/.adhd/test-timings/test-metrics.jsonl` (qa-variance, see
 * docs/discovery/qa-test-variance-tail-policy-backlog-nx.md).
 * Tier: S (support module, no assertions). Item: qa-variance.
 * Red: pending (verification pending, tests not run per user).
 *
 * Safety contract — every clause is checked in code, not assumed:
 *  - The template is built with the SAME calls both openers make
 *    (`createStoreAdapter` + `createGraphBackend(OPEN_TYPE_POLICY)` +
 *    `applySchema()`), then closed, so the file is a quiesced image.
 *  - The template is used ONLY if, after close, no `-wal`/journal sidecar
 *    carries uncommitted pages (a non-empty one). Otherwise `seedFromSchemaTemplate` returns false and the caller
 *    opens the store from scratch exactly as before.
 *  - The copy is placed with link-if-absent semantics: it never replaces an
 *    existing `dbPath`, so a child process opening the SAME path (the
 *    cross-process tests) or a test that pre-creates a store keeps its file,
 *    and a concurrent opener never observes a half-written file (the bytes
 *    are written to a private name first, then hard-linked into place).
 *  - Callers STILL run `applySchema()` after seeding. It is `IF NOT EXISTS`
 *    throughout (idempotent by contract), so a seeded file is verified rather
 *    than trusted.
 *  - Any failure (build, copy, link) returns false: the fallback is the
 *    original cold open, never a skipped step.
 *  - The template lives under the OS temp dir, is private to this process, and
 *    is removed on process exit.
 */
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createStoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { OPEN_TYPE_POLICY } from '../../store/type-policy.js';

let templatePath: Promise<string | null> | undefined;
let copyCounter = 0;

async function buildTemplate(): Promise<string | null> {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'backlog-schema-template-'));
    process.once('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort: OS temp dir */
      }
    });
    const dbPath = join(dir, 'template.db');
    const adapter = await createStoreAdapter({ dbPath });
    try {
      await adapter.pragmaSet('busy_timeout', 5000);
      const graph = createGraphBackend(adapter, {
        typePolicy: OPEN_TYPE_POLICY,
      });
      await graph.applySchema();
    } finally {
      await adapter.close();
    }
    // Only a page-carrying sidecar (a non-empty WAL or rollback journal) makes the image unquiesced. The store
    // adapter also leaves non-page files after close (a stale shared-memory snapshot, a sweep marker, a lease dir);
    // those carry no database pages and must not disable the template.
    const strays = readdirSync(dir).filter(
      (f) => /-(wal|journal)$/.test(f) && statSync(join(dir, f)).size > 0
    );
    if (strays.length > 0 || !existsSync(dbPath)) return null;
    return dbPath;
  } catch {
    return null;
  }
}

/**
 * Places a copy of the schema-applied template at `dbPath` when nothing exists
 * there yet. Returns true when the file was seeded, false when the caller must
 * cold-open (`:memory:`, path already present, template unusable, any error).
 */
export async function seedFromSchemaTemplate(dbPath: string): Promise<boolean> {
  if (dbPath === ':memory:') return false;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    if (existsSync(dbPath)) return false;
    templatePath ??= buildTemplate();
    const template = await templatePath;
    if (template === null) return false;
    const staging = join(
      dirname(dbPath),
      `.${basename(dbPath)}.seed-${process.pid}-${copyCounter++}`
    );
    try {
      copyFileSync(template, staging);
      try {
        linkSync(staging, dbPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
      return true;
    } finally {
      try {
        unlinkSync(staging);
      } catch {
        /* staging already gone */
      }
    }
  } catch {
    return false;
  }
}
