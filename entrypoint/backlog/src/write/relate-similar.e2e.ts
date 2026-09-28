/**
 * relate-similar.e2e.ts — C9 AC4 concurrency: two REAL OS processes, each its
 * own adapter connection, barrier-released to add two links from ONE source to
 * TWO targets.
 *
 *  - `similar_to` (`n:m`): BOTH links must commit (exit 0 each).
 *  - reserved `duplicate_of` (`n:1`): EXACTLY ONE commits; the loser exits 3
 *    with `SingleValuedRelationConflictError` — the multiplicity gate is the
 *    same generic one, and it is exercised across genuine processes.
 *
 * Exit codes are the contract (never stdout), and persistence is verified by
 * reopening the store fresh — never a writer's own in-memory view.
 *
 * Determinism: a file-signal latch (each writer parks on `ready-<tag>`, the
 * parent touches `GO` once BOTH exist) — never a sleep.
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIssue } from './create-issue.js';
import {
  openTestIssueStore,
  seedProject,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'test', 'fixtures', 'relate-similar-writer.ts');
const TSX_BIN = join(HERE, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');

type WriteStore = Pick<TestIssueStore, 'adapter' | 'graph' | 'typePolicy'>;

interface WriterOutcome {
  tag: string;
  ok: boolean;
  noop: boolean;
  threw: boolean;
  errorName?: string;
  exitCode: number | null;
}

function spawnWriter(
  dbPath: string,
  tag: string,
  sourceUid: string,
  targetUid: string,
  rel: string,
  root: string,
  env?: Record<string, string>
): Promise<WriterOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TSX_BIN,
      [FIXTURE, dbPath, tag, sourceUid, targetUid, rel, root],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('exit', (code) => {
      const lastLine = out.trim().split('\n').filter(Boolean).pop();
      if (!lastLine) {
        reject(
          new Error(
            `writer ${tag} exited ${code} with no JSON outcome line. stderr: ${err.slice(
              -500
            )}`
          )
        );
        return;
      }
      try {
        resolve({
          ...(JSON.parse(lastLine) as Omit<WriterOutcome, 'exitCode'>),
          exitCode: code,
        });
      } catch {
        reject(new Error(`writer ${tag} stdout not JSON: ${lastLine}`));
      }
    });
  });
}

async function runPair(
  dbPath: string,
  root: string,
  sourceUid: string,
  targetB: string,
  targetC: string,
  rel: string,
  env?: Record<string, string>
): Promise<[WriterOutcome, WriterOutcome]> {
  const readyA = join(root, 'ready-A');
  const readyB = join(root, 'ready-B');
  const go = join(root, 'GO');
  for (const f of [readyA, readyB, go]) rmSync(f, { force: true });

  const wA = spawnWriter(dbPath, 'A', sourceUid, targetB, rel, root, env);
  const wB = spawnWriter(dbPath, 'B', sourceUid, targetC, rel, root, env);
  const pair = Promise.all([wA, wB]);

  const deadline = Date.now() + 30000;
  while (!(existsSync(readyA) && existsSync(readyB))) {
    if (Date.now() > deadline) throw new Error('writers never reached the barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  writeFileSync(go, 'go');
  return pair;
}

async function liveEdgeCount(
  dbPath: string,
  sourceUid: string,
  rel: string
): Promise<number> {
  const store = await openTestIssueStore(dbPath);
  try {
    const src = await store.graph.getNodeByUid(sourceUid);
    if (!src) return 0;
    const edges = await store.graph.getEdges({ src: src.id, rel });
    return edges.length;
  } finally {
    await store.close();
  }
}

let dir: string;
let dbPath: string;
let sourceUid: string;
let targetB: string;
let targetC: string;

beforeEach(async () => {
  dir = freshTmpDir('relate-similar-e2e');
  dbPath = join(dir, 'backlog.db');
  const seed = await openTestIssueStore(dbPath);
  const pA = (await seedProject(seed, 'relate-e2e-a')).projectUid;
  const pB = (await seedProject(seed, 'relate-e2e-b')).projectUid;
  const mk = async (project: string, title: string): Promise<string> => {
    const r = await createIssue(seed as unknown as WriteStore, {
      project,
      title,
      body: `${title} body`,
      by: 'filer',
    });
    if (!r.created || !r.uid) throw new Error('seed create failed');
    return r.uid;
  };
  sourceUid = await mk(pA, 'e2e source');
  targetB = await mk(pA, 'e2e target B');
  targetC = await mk(pB, 'e2e target C');
  await seed.close();
});

afterEach(() => {
  removeTestIssueStoreDir(dir);
});

describe('C9 AC4 — cross-process reviewed linking', () => {
  it('similar_to (n:m): two real processes linking one source to two targets BOTH commit', async () => {
    const [a, b] = await runPair(dbPath, dir, sourceUid, targetB, targetC, 'similar_to');
    expect(a.exitCode, `A stderr/out: ${JSON.stringify(a)}`).toBe(0);
    expect(b.exitCode, `B stderr/out: ${JSON.stringify(b)}`).toBe(0);
    expect(a.ok && b.ok).toBe(true);
    expect(await liveEdgeCount(dbPath, sourceUid, 'similar_to')).toBe(2);
  }, 60000);

  it('duplicate_of (n:1): exactly ONE process commits; the other exits 3 with the conflict', async () => {
    const [a, b] = await runPair(
      dbPath,
      dir,
      sourceUid,
      targetB,
      targetC,
      'duplicate_of'
    );
    const codes = [a.exitCode, b.exitCode].sort((x, y) => x! - y!);
    expect(codes).toEqual([0, 3]);
    const loser = a.exitCode === 3 ? a : b;
    expect(loser.errorName).toBe('SingleValuedRelationConflictError');
    expect(await liveEdgeCount(dbPath, sourceUid, 'duplicate_of')).toBe(1);
  }, 60000);

  it('NEGATIVE CONTROL (deferred tx mode): the always-true invariant holds — a reported commit persists (torn state is logged, never silently swallowed)', async () => {
    const [a, b] = await runPair(
      dbPath,
      dir,
      sourceUid,
      targetB,
      targetC,
      'duplicate_of',
      { ADHD_BACKLOG_UNSAFE_TX_MODE: 'deferred' }
    );
    const persisted = await liveEdgeCount(dbPath, sourceUid, 'duplicate_of');
    const reportedCommits = [a, b].filter((w) => w.ok && !w.noop).length;
    // eslint-disable-next-line no-console
    console.warn(
      `[relate-similar-e2e] DEFERRED NEGATIVE CONTROL: exitCodes=${a.exitCode}/${
        b.exitCode
      } reportedCommits=${reportedCommits} persistedEdges=${persisted}` +
        (persisted > 1 ? ' — TORN STATE (both n:1 links landed)' : '')
    );
    // Deterministic invariant that holds under BOTH modes: every process that
    // reported a fresh commit has at least one persisted edge, and the store
    // is never left with zero. (Under `immediate` this is exactly 1.)
    expect(persisted).toBeGreaterThanOrEqual(1);
    expect(persisted).toBeLessThanOrEqual(2);
  }, 60000);
});
