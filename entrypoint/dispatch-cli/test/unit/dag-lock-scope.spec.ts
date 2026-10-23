/**
 * dag-lock-scope.spec.ts — pins exactly what `withDagLock` / `runCycleCore`
 * serialize in dispatch-cli: ONE orchestrator cycle per `runCycleCore` call, and
 * a multi-cycle caller must wrap its own loop in `withDagLock`.
 *
 * Guards: a withDagLock doc that claims an orchestrate loop is wrapped when only one cycle per runCycleCore is locked; a second concurrent cycle on one DAG; a lock held between cycles.
 * Failure mode: core.ts's `withDagLock` JSDoc claims `orchestrate()`'s loop is
 * wrapped, but nothing in dispatch-cli calls `orchestrate()` (it is an exported
 * generator of `@adhd/dispatch-orchestrator`); a reader trusts the comment and
 * runs two multi-cycle loops on one DAG believing they cannot interleave. The
 * behavioural pins make the true scope observable: a second concurrent
 * `runCycleCore` is refused mid-cycle, and the lock is free between two
 * sequential cycles.
 * Tier: S (real fs under <repo>/tmp, a private TMPDIR relocating the lock file,
 *   an injected MockAgentRunner subclass that parks on a latch; no process is
 *   spawned, no network, no sleeps).
 * Gap statement: tier S suffices; the lock is observed through the real
 *   `runCycleCore` / `acquireDispatchLock` pair on a real file.
 * Cites: plan discovery-sweep-1014 blind-review B AC1.
 * Red run (recorded against the unfixed core.ts, `npx vitest run
 *   src/test/dag-lock-scope.spec.ts`, exit 1): the doc-claim test fails with
 *   `AssertionError: expected true to be false` at the claim assertion; the two
 *   behavioural tests pin the true scope and pass before and after.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { acquireDispatchLock, DuplicateDispatchError, MockAgentRunner } from '@adhd/dispatch-orchestrator';
import type { DispatchUnit } from '@adhd/dispatch-base-spec';

import * as core from '../../src/lib/core.js';
import { makeFixtureDag, makeOp } from '../../src/test/helpers/fixtures.js';

const TMP_ROOT = path.join(process.cwd(), 'tmp', 'dispatch-cli', 'dag-lock-scope-spec');
const OTHER_PROCESS_PID = 2_147_000_000;

let savedTmpdir: string | undefined;
let caseN = 0;
const runners: MockAgentRunner[] = [];

/** A MockAgentRunner that signals when a cycle has reached the agent boundary and parks until released. */
class ParkingRunner extends MockAgentRunner {
  readonly entered: Promise<void>;
  private markEntered!: () => void;
  private releaseGate!: () => void;
  private readonly gate: Promise<void>;
  constructor(debugDir: string) {
    super({ debugDir });
    this.entered = new Promise<void>((r) => (this.markEntered = r));
    this.gate = new Promise<void>((r) => (this.releaseGate = r));
  }
  release(): void {
    this.releaseGate();
  }
  override async ensureAgent(unit: DispatchUnit): Promise<void> {
    this.markEntered();
    await this.gate;
    return super.ensureAgent(unit);
  }
}

function newCase() {
  const dir = path.join(TMP_ROOT, `case-${caseN++}`);
  const tmp = path.join(dir, 'tmp');
  const dagPath = path.join(dir, 'dag.json');
  fs.mkdirSync(tmp, { recursive: true });
  process.env['TMPDIR'] = tmp; // os.tmpdir() reads this at call time
  fs.writeFileSync(
    dagPath,
    JSON.stringify(makeFixtureDag({ operations: [makeOp({ id: 'a.1', milestone: 'a', depends_on: [] })] }), null, 2),
    'utf8'
  );
  return { dir, dagPath, lockPath: core.dispatchLockPath(dagPath) };
}

function otherProcessAcquire(lockPath: string, dagPath: string): DuplicateDispatchError | null {
  try {
    acquireDispatchLock(lockPath, path.resolve(dagPath), { pid: OTHER_PROCESS_PID }).release();
    return null;
  } catch (e) {
    if (e instanceof DuplicateDispatchError) return e;
    throw e;
  }
}

beforeAll(() => {
  savedTmpdir = process.env['TMPDIR'];
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});
afterEach(() => {
  for (const r of runners.splice(0)) r.cleanup();
});
afterAll(() => {
  if (savedTmpdir === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmpdir;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('plan discovery-sweep-1014 blind-review B AC1: what the dag lock serializes', () => {
  it('plan discovery-sweep-1014 blind-review B AC1: core.ts does not claim an orchestrate() loop is wrapped by withDagLock (no such caller exists)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'lib', 'core.ts'), 'utf8');
    const callsOrchestrateLoop = /\bfor await\b[^\n]*\borchestrate\(/.test(src) || /\bimport\b[^;]*\borchestrate\b[^;]*from/.test(src);
    const claimsItIsWrapped = /orchestrate\(\)/.test(src);
    // Either the loop exists in core.ts and is wrapped, or the comment must not name it.
    expect(callsOrchestrateLoop || !claimsItIsWrapped).toBe(true);
  });

  it('plan discovery-sweep-1014 blind-review B AC1: a second concurrent runCycleCore on one DAG is refused mid-cycle and the first cycle completes', async () => {
    const c = newCase();
    const first = new ParkingRunner(path.join(c.dir, 'mock-debug-1'));
    const second = new ParkingRunner(path.join(c.dir, 'mock-debug-2'));
    runners.push(first, second);

    const cycleA = core.runCycleCore(c.dagPath, true, first);
    await first.entered; // cycle A is parked inside the agent boundary, holding the lock
    expect(fs.existsSync(c.lockPath)).toBe(true);

    const refusal = await core.runCycleCore(c.dagPath, true, second).then(
      () => null,
      (e: unknown) => e
    );
    expect(refusal).toBeInstanceOf(DuplicateDispatchError);
    expect(otherProcessAcquire(c.lockPath, c.dagPath)).toBeInstanceOf(DuplicateDispatchError);

    first.release();
    await expect(cycleA).resolves.toBeDefined();
    expect(fs.existsSync(c.lockPath)).toBe(false);
  });

  it('plan discovery-sweep-1014 blind-review B AC1: the lock is released between two sequential runCycleCore calls (a multi-cycle caller must wrap its loop in withDagLock)', async () => {
    const c = newCase();
    const r = new MockAgentRunner({ debugDir: path.join(c.dir, 'mock-debug') });
    runners.push(r);

    await core.runCycleCore(c.dagPath, true, r);
    expect(fs.existsSync(c.lockPath)).toBe(false);
    expect(otherProcessAcquire(c.lockPath, c.dagPath), 'a competitor can take the lock between cycles').toBeNull();
  });
});
