/**
 * 56a2133e — "Write I/O failure: an unclassified driver/connection error"
 * repeated 5/5 on ONE production `create` payload while every other write in
 * the same minutes succeeded.
 *
 * Root cause (confirmed by driving the exact payload shape here): the
 * payload's citation named a DIRECTORY (`libs/data/store/store-adapter`, no
 * file, no line). Both `computeCitationSha` copies (`create-issue.ts`,
 * `transition.ts`) called `readFile` on it, got `EISDIR`, and wrapped that in
 * `WriteIOError`, which rendered as a driver fault with `retryable: true`. The
 * raw errno was never logged, and the envelope message did not carry it, so
 * the failure could not be told apart from a store fault.
 *
 * This suite pins both halves of the fix against a REAL store and the REAL
 * `@adhd/sox-telemetry` file sink:
 *  1. A directory citation is a caller mistake: `CitationTargetIsDirectoryError`
 *     (`E_VALIDATION`, `retryable: false`), surfaced through the public `api`
 *     envelope as `validation`, and nothing is written.
 *  2. Every `E_IO` the write layer still produces carries the raw message on
 *     the error AND emits an `error`-level `backlog.write.io_failure` telemetry
 *     record with the raw message/code/stack.
 */
import { join } from 'node:path';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetTelemetryForTest, initTelemetry } from '@adhd/sox-telemetry';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { createIssue } from './create-issue.js';
import { transition } from './transition.js';
import { upsertProject } from './catalog.js';
import {
  CitationTargetIsDirectoryError,
  WRITE_IO_FAILURE_EVENT,
  WriteIOError,
  classifyDriverError,
} from './errors.js';

interface ITelemetryRecord {
  level: string;
  event: string;
  origin?: string;
  retryable?: boolean;
  error?: string;
  error_code?: string;
  stack?: string;
}

/** Every record the real file sink wrote under `logDir`, parsed. */
function readTelemetry(logDir: string): ITelemetryRecord[] {
  return readdirSync(logDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(logDir, f), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as ITelemetryRecord)
    );
}

function ioFailureRecords(logDir: string): ITelemetryRecord[] {
  return readTelemetry(logDir).filter((r) => r.event === WRITE_IO_FAILURE_EVENT);
}

describe('56a2133e — E_IO instrumentation and the directory-citation root cause', () => {
  let dir: string;
  let projectDir: string;
  let logDir: string;
  let store: TestIssueStore;

  beforeEach(async () => {
    dir = freshTmpDir('write-io-failure-spec');
    projectDir = join(dir, 'project');
    // The production payload's citation target, as a real directory.
    mkdirSync(join(projectDir, 'libs/data/store/store-adapter'), {
      recursive: true,
    });
    writeFileSync(join(projectDir, 'libs/data/store/store-adapter/index.ts'), 'x');
    logDir = mkdtempSync(join(tmpdir(), 'backlog-56a2133e-telemetry-'));
    _resetTelemetryForTest();
    initTelemetry({ service: 'backlog', role: 'cli', logSink: 'file', logDir });
    store = await openTestIssueStore(join(dir, 'backlog.db'));
  });

  afterEach(async () => {
    await store.close();
    _resetTelemetryForTest();
    rmSync(logDir, { recursive: true, force: true });
    removeTestIssueStoreDir(dir);
  });

  async function liveCounts(): Promise<{ nodes: number; edges: number }> {
    const n = await store.adapter.executeAll<{ n: number }>(
      'SELECT COUNT(*) as n FROM node WHERE t_invalid IS NULL'
    );
    const e = await store.adapter.executeAll<{ n: number }>(
      'SELECT COUNT(*) as n FROM edge WHERE t_invalid IS NULL'
    );
    return { nodes: n.rows[0]?.n ?? 0, edges: e.rows[0]?.n ?? 0 };
  }

  it('create: the production payload (directory citation) is E_VALIDATION, not retryable, and deterministic — 5/5 identical, nothing written', async () => {
    const project = await upsertProject(store, {
      name: 'sox-ecosystem',
      by: 'filer:1',
      path: projectDir,
    });
    const before = await liveCounts();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const err = await createIssue(store, {
        project: project.uid,
        title:
          'store-adapter full suite: 1 of 4 full runs failed with an unidentified test',
        body: 'flake, cause unknown',
        priority: 'MEDIUM',
        by: 'filer:1',
        citations: [{ file: 'libs/data/store/store-adapter' }],
      }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(CitationTargetIsDirectoryError);
      expect(err).not.toBeInstanceOf(WriteIOError);
      const typed = err as CitationTargetIsDirectoryError;
      expect(typed.code).toBe('E_VALIDATION');
      expect(typed.retryable).toBe(false);
      expect(typed.message).toContain('libs/data/store/store-adapter');
      expect(typed.message).toContain('is a directory');
    }

    expect(await liveCounts()).toEqual(before);
    // A validation error is not an I/O fault — it must not be logged as one.
    expect(ioFailureRecords(logDir)).toEqual([]);

    // The SAME payload citing a FILE inside that directory succeeds.
    const ok = await createIssue(store, {
      project: project.uid,
      title: 'same payload, file citation',
      body: 'flake, cause unknown',
      priority: 'MEDIUM',
      by: 'filer:1',
      citations: [{ file: 'libs/data/store/store-adapter/index.ts' }],
    });
    expect(ok.created).toBe(true);
  });

  it('transition: a directory citation is the same E_VALIDATION class (the second computeCitationSha copy)', async () => {
    const project = await upsertProject(store, {
      name: 'transition-dir-cite',
      by: 'filer:1',
      path: projectDir,
    });
    const created = await createIssue(store, {
      project: project.uid,
      title: 'to be transitioned',
      body: 'b',
      by: 'filer:1',
    });
    const err = await transition(store, {
      uid: created.uid,
      by: 'filer:1',
      toStatus: 'in_progress',
      note: 'n',
      citations: [{ file: 'libs/data/store/store-adapter' }],
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(CitationTargetIsDirectoryError);
    expect((err as CitationTargetIsDirectoryError).retryable).toBe(false);
  });

  it('a REAL citation I/O fault (EACCES) stays E_IO but now carries the raw errno message and emits an error-level telemetry record', async () => {
    if (process.getuid?.() === 0) {
      throw new Error(
        'this assertion needs a non-root user: root ignores chmod 000, so EACCES cannot be produced'
      );
    }
    const project = await upsertProject(store, {
      name: 'eacces-cite',
      by: 'filer:1',
      path: projectDir,
    });
    const locked = join(projectDir, 'locked.ts');
    writeFileSync(locked, 'secret');
    chmodSync(locked, 0o000);
    try {
      const err = await createIssue(store, {
        project: project.uid,
        title: 'unreadable citation',
        body: 'b',
        by: 'filer:1',
        citations: [{ file: 'locked.ts' }],
      }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(WriteIOError);
      const io = err as WriteIOError;
      expect(io.causeCode).toBe('EACCES');
      expect(io.causeMessage).toContain('EACCES');
      expect(io.message).toContain(io.causeMessage);

      const records = ioFailureRecords(logDir);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: 'error',
        origin: 'citation_sha',
        error_code: 'EACCES',
      });
      expect(records[0]?.error).toContain('EACCES');
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it('classifyDriverError logs the raw Turso driver message at error level, and WriteIOError exposes it (message + causeMessage)', () => {
    // Exactly the shape @tursodatabase/database rejects with: code
    // GenericFailure and a phase-prefixed message (isDatabaseError → true).
    const driverErr = Object.assign(
      new Error('step failed: I/O error: short read on WAL frame 1234'),
      { code: 'GenericFailure' }
    );
    const classified = classifyDriverError(driverErr);
    expect(classified).toMatchObject({ code: 'E_IO', retryable: true });

    const records = ioFailureRecords(logDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      origin: 'transaction',
      retryable: true,
      error: 'step failed: I/O error: short read on WAL frame 1234',
      error_code: 'GenericFailure',
    });
    expect(records[0]?.stack).toContain('short read on WAL frame 1234');

    const wrapped = new WriteIOError(driverErr);
    expect(wrapped.causeMessage).toBe(
      'step failed: I/O error: short read on WAL frame 1234'
    );
    expect(wrapped.causeCode).toBe('GenericFailure');
    expect(wrapped.message).toContain('short read on WAL frame 1234');
    expect(wrapped.cause).toBe(driverErr);
  });

  it('classifyDriverError does NOT log contention or constraint classes (only E_IO is instrumented)', () => {
    classifyDriverError(
      Object.assign(new Error('step failed: database is locked'), {
        code: 'GenericFailure',
      })
    );
    expect(ioFailureRecords(logDir)).toEqual([]);
  });
});
