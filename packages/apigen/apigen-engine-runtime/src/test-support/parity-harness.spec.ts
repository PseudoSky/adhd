/**
 * parity-harness self-test ([parity-harness.3]).
 *
 * Proves the shared golden-fixture parity harness itself works, with teeth:
 *   - `captureGolden` drives a REAL consumer protocol (an actual `node:http`
 *     server, called over the wire via `fetch` — [def:real-consumer-protocol])
 *     and records a snapshot.
 *   - `assertParity` deep-equals a committed snapshot against a recapture and
 *     — the required negative control — REJECTS when a recapture diverges
 *     ([inv:byte-identical]).
 *   - `proveNegativeControl` drives a REAL `git apply`/`git apply -R` cycle
 *     against an ephemeral, disposable git repository that is PROVABLY
 *     isolated from the enclosing repo ([inv:negative-control],
 *     BUG-APIGEN-052) and — its own negative control — REJECTS when the
 *     supplied patch fails to turn the suite RED, proving the
 *     negative-control machinery can itself fail loudly rather than
 *     rubber-stamping a broken gate.
 *
 * No mocking of anything under test: the HTTP server is real, `fetch` is the
 * real global, and the git repo is a real (throwaway) repository — created
 * via `createIsolatedScratchRepo`, which lives under `os.tmpdir()` (never
 * nested inside this — or any — tracked working tree) and asserts its own
 * isolation before this suite ever touches it (see BUG-APIGEN-052 in
 * `isolated-git.spec.ts` for the proven escape mechanism and its fix).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertParity,
  captureGolden,
  createIsolatedScratchRepo,
  ParityMismatchError,
  proveNegativeControl,
  runGit,
  type GoldenFixture,
  type GoldenSnapshot,
  type ParityDriver,
} from './parity-harness';

/** Bind a TCP server to port 0, record the OS-assigned port, close it, return that port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// captureGolden + assertParity — driven over a REAL HTTP server via `fetch`
// ---------------------------------------------------------------------------

describe('captureGolden + assertParity (real HTTP consumer protocol)', () => {
  let server: http.Server;
  let port: number;

  type EchoResult = { echo: unknown; method: string | undefined; url: string | undefined };
  type Fixture = GoldenFixture<{ path: string; body: unknown }>;

  beforeAll(async () => {
    port = await freePort();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const body: EchoResult = { echo: parsed, method: req.method, url: req.url };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  const driver: ParityDriver<{ path: string; body: unknown }, EchoResult> = {
    async invoke(fixture: Fixture): Promise<EchoResult> {
      const res = await fetch(`http://127.0.0.1:${port}${fixture.input.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fixture.input.body),
      });
      return (await res.json()) as EchoResult;
    },
  };

  const fixtures: Fixture[] = [
    { name: 'safe-scalar', input: { path: '/users/1', body: {} } },
    { name: 'unsafe-mutating', input: { path: '/users', body: { name: 'ada' } } },
  ];

  it('drives the real HTTP transport and records a snapshot keyed by fixture name', async () => {
    const snapshot = await captureGolden(driver, fixtures);
    expect(snapshot['safe-scalar']).toEqual({ echo: {}, method: 'POST', url: '/users/1' });
    expect(snapshot['unsafe-mutating']).toEqual({
      echo: { name: 'ada' },
      method: 'POST',
      url: '/users',
    });
  });

  it('rejects an empty fixture list — an empty capture proves nothing', async () => {
    await expect(captureGolden(driver, [])).rejects.toThrow(/empty/);
  });

  it('rejects duplicate fixture names — they would silently clobber the snapshot key', async () => {
    await expect(
      captureGolden(driver, [fixtures[0], { ...fixtures[0] }])
    ).rejects.toThrow(/duplicate/);
  });

  it('assertParity passes silently for a byte-identical recapture', async () => {
    const committed = await captureGolden(driver, fixtures);
    const recapture = await captureGolden(driver, fixtures);
    expect(() => assertParity(committed, recapture)).not.toThrow();
  });

  it('[inv:negative-control] assertParity REJECTS a mismatched recapture — teeth for the deep-equal check', async () => {
    const committed = await captureGolden(driver, fixtures);
    const recapture = await captureGolden(driver, fixtures);
    // Mutate exactly one field the way a real transport-migration regression
    // would: same shape, one diverged value.
    (recapture['unsafe-mutating'] as EchoResult).echo = { name: 'MUTATED' };

    let thrown: unknown;
    try {
      assertParity(committed, recapture);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ParityMismatchError);
    expect((thrown as ParityMismatchError).fixtureNames).toEqual(['unsafe-mutating']);
    expect((thrown as Error).message).toContain('unsafe-mutating');
    // The unaffected fixture must NOT be reported — proves the check is
    // per-fixture, not an all-or-nothing snapshot hash comparison.
    expect((thrown as Error).message).not.toContain('safe-scalar');
  });

  it('reports a fixture missing from the recapture', () => {
    const committed: GoldenSnapshot<number> = { a: 1, b: 2 };
    const recapture: GoldenSnapshot<number> = { a: 1 };
    expect(() => assertParity(committed, recapture)).toThrow(/missing from recapture: b/);
  });

  it('reports an unexpected extra fixture added in the recapture', () => {
    const committed: GoldenSnapshot<number> = { a: 1 };
    const recapture: GoldenSnapshot<number> = { a: 1, b: 2 };
    expect(() => assertParity(committed, recapture)).toThrow(
      /unexpected extra fixture\(s\) in recapture: b/
    );
  });

  it('[inv:byte-identical] distinguishes an explicit undefined value from an absent key', () => {
    expect(() => assertParity({ a: undefined }, {})).toThrow(ParityMismatchError);
  });
});

// ---------------------------------------------------------------------------
// proveNegativeControl — driven over a REAL, disposable, PROVABLY isolated
// git repo under os.tmpdir() (BUG-APIGEN-052)
// ---------------------------------------------------------------------------

describe('proveNegativeControl (real git apply / git apply -R cycle)', () => {
  let repoDir: string;
  let patchPath: string;
  let subjectPath: string;

  function git(...args: string[]): string {
    return runGit(args, { cwd: repoDir });
  }

  function readSubject(): string {
    return fs.readFileSync(subjectPath, 'utf8');
  }

  /** Stand-in "parity suite": GREEN iff the tracked file still reads its committed content. */
  function runner(): void {
    const content = readSubject();
    if (content !== 'before\n') {
      throw new Error(`parity broken: subject.txt reads "${content.trim()}", expected "before"`);
    }
  }

  beforeAll(() => {
    // BUG-APIGEN-052: createIsolatedScratchRepo lives under os.tmpdir() (never
    // nested inside this — or any — tracked working tree) and asserts its own
    // isolation (`git rev-parse --show-toplevel` resolves to itself) before
    // returning — this suite never gets a repoDir that hasn't been proven
    // isolated from the enclosing repo.
    repoDir = createIsolatedScratchRepo('apigen-parity-harness-self-test-').dir;
    subjectPath = path.join(repoDir, 'subject.txt');

    git('config', 'user.email', 'parity-harness-self-test@example.com');
    git('config', 'user.name', 'parity-harness-self-test');
    fs.writeFileSync(subjectPath, 'before\n');
    git('add', 'subject.txt');
    git('commit', '-q', '-m', 'init: subject.txt');

    // Author the one-line regression as a REAL `git diff`-produced patch —
    // exactly how a transport migration commits `neg-control/<slug>.patch`
    // ([inv:negative-control]) — then restore the committed content with a
    // single-file `git restore` (never `git checkout -- .` / `git reset
    // --hard` over a tree).
    fs.writeFileSync(subjectPath, 'after\n');
    const diff = git('diff', '--', 'subject.txt');
    git('restore', '--', 'subject.txt');
    expect(readSubject()).toBe('before\n');

    patchPath = path.join(repoDir, 'neg-control.patch');
    fs.writeFileSync(patchPath, diff);
  });

  afterAll(() => {
    // Test cleans up after itself (AGENTS.md §10) — the scratch repo lives
    // entirely under os.tmpdir(), never in the tracked tree.
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('applies the patch (drives the suite RED), reverts it (GREEN), and leaves the tree clean', async () => {
    expect(readSubject()).toBe('before\n');

    await expect(
      proveNegativeControl(runner, patchPath, { cwd: repoDir })
    ).resolves.toBeUndefined();

    // Reverted — back to the committed, GREEN state.
    expect(readSubject()).toBe('before\n');
  });

  it('[inv:negative-control] proveNegativeControl ITSELF rejects a patch that fails to turn the suite RED — teeth', async () => {
    const alwaysGreen = (): void => {
      /* never throws, no matter what the patch did to subject.txt — a broken gate */
    };

    await expect(
      proveNegativeControl(alwaysGreen, patchPath, { cwd: repoDir })
    ).rejects.toThrow(/stayed GREEN/);

    // Even on this failure path, the patch must still be reverted (the
    // `finally` cleanup runs regardless of which branch threw).
    expect(readSubject()).toBe('before\n');
  });

  it('propagates a post-revert GREEN-check failure instead of masking it as "no gate"', async () => {
    const alwaysRed = (): never => {
      throw new Error('always red');
    };

    // `alwaysRed` throws on the patched (RED) call too, so the "stayed
    // GREEN" diagnostic never fires — but the mandatory post-revert
    // green-check call also throws, and THAT rejection must propagate
    // untouched (a genuinely broken runner is not "the gate never fails").
    await expect(
      proveNegativeControl(alwaysRed, patchPath, { cwd: repoDir })
    ).rejects.toThrow('always red');

    expect(readSubject()).toBe('before\n');
  });
});
