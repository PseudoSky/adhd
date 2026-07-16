// extraction-session.spec.ts — regression net for the shared-session
// performance work (deterministic, timing-free: asserts WORK COUNTS and
// cache shapes, so it goes red if the redundant-program regression returns,
// regardless of machine speed).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extract } from '../lib/extract';
import { generateSchemas } from '../lib/generate-schemas';
import {
  createExtractionSession,
  internalSession,
  clearPersistentProjectCache,
} from '../lib/extraction-session';

let dir: string;
let fileA: string;
let fileB: string;

const SOURCE_A = `
export interface IUser { id: string; createdAt: Date; balance: bigint }
export function getUser(id: string, verbose?: boolean): IUser {
  return { id, createdAt: new Date(), balance: 0n }
}
export async function listUsers(limit: number): Promise<IUser[]> { return [] }
export const tag = (u: IUser, labels: string[]): { u: IUser; labels: string[] } => ({ u, labels })
`;

const SOURCE_B = `
export function ping(host: string): { ok: boolean; at: Date } {
  return { ok: !!host, at: new Date() }
}
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-session-spec-'));
  fileA = path.join(dir, 'a.ts');
  fileB = path.join(dir, 'b.ts');
  fs.writeFileSync(fileA, SOURCE_A);
  fs.writeFileSync(fileB, SOURCE_B);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from a cold process-level cache so counts are exact.
  clearPersistentProjectCache();
});

describe('shared ExtractionSession eliminates redundant program builds', () => {
  it('extract + generateSchemas of the same file build ONE Project and ONE generator', async () => {
    const session = createExtractionSession();
    const internal = internalSession(session);

    const ops = await extract({ sourceFile: fileA, session });
    expect(ops.length).toBeGreaterThan(0);
    const afterExtract = { ...internal.stats };

    // The orchestrator's second pass over the same file: with the shared
    // session this must build NOTHING new — pure cache hits.
    const generated = await generateSchemas({ sourceFile: fileA, session });
    expect(Object.keys(generated.schemas).length).toBeGreaterThan(0);

    expect(internal.stats.projectsBuilt).toBe(afterExtract.projectsBuilt);
    expect(internal.stats.generatorsBuilt).toBe(afterExtract.generatorsBuilt);
    expect(internal.stats.schemaCacheHits).toBeGreaterThan(0);

    // One Project for the whole session (no tsconfig → one key).
    expect(internal.stats.projectsBuilt).toBe(1);
    session.dispose();
  });

  it('two sources share one Project; generator cache holds ≤1 entry per file', async () => {
    const session = createExtractionSession();
    const internal = internalSession(session);

    await extract({ sourceFile: fileA, session });
    await extract({ sourceFile: fileB, session });

    expect(internal.stats.projectsBuilt).toBe(1);
    // Bounded: at most one generator entry per (file, tsconfig).
    expect(internal.generatorCache.size).toBeLessThanOrEqual(2);
    session.dispose();
  });

  it('descriptor built with a shared session deep-equals one built session-less', async () => {
    const withSession = createExtractionSession();
    const opsShared = await extract({
      sourceFile: fileA,
      session: withSession,
    });
    withSession.dispose();

    clearPersistentProjectCache(); // sever the persistent tier between the two builds
    const opsPlain = await extract({ sourceFile: fileA });

    expect(opsShared).toEqual(opsPlain);
  });

  it('session cannot be used after dispose()', async () => {
    const session = createExtractionSession();
    await extract({ sourceFile: fileA, session });
    session.dispose();
    await expect(extract({ sourceFile: fileA, session })).rejects.toThrow(
      /dispose/
    );
  });
});

describe('persistent tier: reuse across sessions, refresh on edit', () => {
  it('a second session over the unchanged file builds 0 Projects and 0 generators', async () => {
    const s1 = createExtractionSession();
    await extract({ sourceFile: fileA, session: s1 });
    s1.dispose();

    const s2 = createExtractionSession();
    const i2 = internalSession(s2);
    const ops = await extract({ sourceFile: fileA, session: s2 });
    expect(ops.length).toBeGreaterThan(0);
    expect(i2.stats.projectsBuilt).toBe(0);
    expect(i2.stats.generatorsBuilt).toBe(0);
    s2.dispose();
  });

  it('editing the file is picked up by the next session (no stale schemas)', async () => {
    const editable = path.join(dir, 'editable.ts');
    fs.writeFileSync(
      editable,
      `export function f(x: string): string { return x }\n`
    );

    const s1 = createExtractionSession();
    const before = await extract({ sourceFile: editable, session: s1 });
    s1.dispose();
    expect(
      (before[0].input as { properties: Record<string, unknown> }).properties[
        'x'
      ]
    ).toEqual({ type: 'string' });

    // Rewrite with a different param type — mtime/size change re-versions it.
    fs.writeFileSync(
      editable,
      `export function f(x: number): number { return x }\n`
    );

    const s2 = createExtractionSession();
    const after = await extract({ sourceFile: editable, session: s2 });
    s2.dispose();
    expect(
      (after[0].input as { properties: Record<string, unknown> }).properties[
        'x'
      ]
    ).toEqual({ type: 'number' });
  });
});

describe('DEBT-APIGEN-CACHE-001: cross-file type changes invalidate the persistent schema cache', () => {
  it('editing an IMPORTED (non-entry) file is picked up even though the entry file itself never changes', async () => {
    const sharedPath = path.join(dir, 'cache-shared.ts');
    const entryPath = path.join(dir, 'cache-entry.ts');
    fs.writeFileSync(sharedPath, `export interface Shared { a: string }\n`);
    // Entry file is written ONCE and never rewritten in this test — the
    // whole point is that ITS version stamp alone must not gate the cache.
    fs.writeFileSync(
      entryPath,
      `import type { Shared } from './cache-shared';\n` +
        `export async function getShared(): Promise<Shared> { return { a: '' } as Shared }\n`
    );

    const s1 = createExtractionSession();
    const before = await generateSchemas({ sourceFile: entryPath, session: s1 });
    s1.dispose();
    const beforeProps = (before.schemas['getShared'].output as {
      properties: Record<string, unknown>;
    }).properties;
    expect(beforeProps).toHaveProperty('a');
    expect(beforeProps).not.toHaveProperty('bExtra');

    // Rewrite ONLY the imported file — a different byte size guarantees a
    // different `mtimeMs:size` version stamp deterministically, sidestepping
    // any filesystem mtime-resolution flakiness (no sleep needed).
    fs.writeFileSync(
      sharedPath,
      `export interface Shared { a: string; bExtra: number }\n`
    );

    const s2 = createExtractionSession();
    const after = await generateSchemas({ sourceFile: entryPath, session: s2 });
    s2.dispose();
    const afterProps = (after.schemas['getShared'].output as {
      properties: Record<string, unknown>;
    }).properties;

    // Before DEBT-APIGEN-CACHE-001's fix, `persistentSchemasFor` versioned
    // ONLY the entry file — since `entryPath` never changed, this would
    // incorrectly return the STALE cached schema (missing `bExtra`).
    expect(afterProps).toHaveProperty('bExtra');
    expect(afterProps).toHaveProperty('a');
  });

  it('two sessions over an UNCHANGED entry+imported-file pair still hit the persistent cache (no regression to always-miss)', async () => {
    const sharedPath = path.join(dir, 'cache-shared-stable.ts');
    const entryPath = path.join(dir, 'cache-entry-stable.ts');
    fs.writeFileSync(sharedPath, `export interface Stable { z: number }\n`);
    fs.writeFileSync(
      entryPath,
      `import type { Stable } from './cache-shared-stable';\n` +
        `export async function getStable(): Promise<Stable> { return { z: 1 } as Stable }\n`
    );

    const s1 = createExtractionSession();
    await generateSchemas({ sourceFile: entryPath, session: s1 });
    s1.dispose();

    const s2 = createExtractionSession();
    const i2 = internalSession(s2);
    await generateSchemas({ sourceFile: entryPath, session: s2 });
    s2.dispose();

    // Nothing changed on disk — must be a pure cache hit, not a rebuild.
    expect(i2.stats.schemaCacheHits).toBeGreaterThan(0);
    expect(i2.stats.schemaCacheMisses).toBe(0);
  });
});

describe('probe hygiene on the shared Project', () => {
  it('anonymous-type resolution leaves the SourceFile text unchanged', async () => {
    const session = createExtractionSession();
    const internal = internalSession(session);

    await extract({ sourceFile: fileA, session }); // exercises morph-walk probes (inline object return)
    const sf = internal.sourceFileFor(fileA);
    expect(sf.getFullText()).toBe(SOURCE_A);
    expect(sf.getFullText()).not.toContain('__ApigenProbe');
    session.dispose();
  });
});
