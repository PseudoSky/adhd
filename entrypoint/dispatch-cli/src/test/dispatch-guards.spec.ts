/**
 * Consumer-level proofs for bucket D, driven through dispatch-cli's real
 * `validateCore` / `runCycleCore` entrypoints (the functions `dispatch validate`
 * and `dispatch run` call), against real dag.json files on disk.
 *
 *   7ed25125 D-AC1  `dispatch validate` refuses a lane whose tool grant cannot satisfy it
 *   d794287f D-AC3  `dispatch run` refuses a second live run of the same dag
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DagJson } from '@adhd/dispatch-base-spec';
import { createDagClient } from '@adhd/dispatch-core-client';
import { createJsonFileSerializer } from '@adhd/dispatch-serializer-json';
import { acquireDispatchLock, DuplicateDispatchError, MockAgentRunner } from '@adhd/dispatch-orchestrator';

import { dispatchLockPath, runCycleCore, validateCore } from '../lib/core.js';
import { makeFixtureDag } from './helpers/fixtures.js';

const TMP_ROOT = path.join(process.cwd(), 'tmp', 'dispatch-cli', 'guards-spec');
beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});
afterAll(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

let n = 0;
async function writeDag(dag: DagJson): Promise<string> {
  const dir = path.join(TMP_ROOT, `case-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'dag.json');
  await createDagClient(createJsonFileSerializer(p)).saveDag(dag);
  return p;
}

describe('7ed25125 D-AC1 dispatch validate: lane / tool grant', () => {
  it('7ed25125 D-AC1: a node declaring lane "research" with a grant lacking research tools fails validate with the typed error; adding the tool passes', async () => {
    const bad = makeFixtureDag();
    Object.assign(bad.milestones['a'] as object, { lane: 'research', tool_grant: ['Read', 'Write'] });
    const badResult = await validateCore(await writeDag(bad));
    expect(badResult.valid).toBe(false);
    expect(badResult.errors.some((e) => e.code === 'lane_tool_grant_unsatisfied' && e.path === 'milestones.a.tool_grant')).toBe(true);

    const good = makeFixtureDag();
    Object.assign(good.milestones['a'] as object, { lane: 'research', tool_grant: ['Read', 'Write', 'WebSearch'] });
    expect(await validateCore(await writeDag(good))).toEqual({ valid: true, errors: [] });
  });
});

describe('d794287f D-AC3 dispatch run: duplicate-dispatch guard', () => {
  it('d794287f D-AC3: a second live run of the same dag is refused; once the first releases, the run proceeds and releases its own lock', async () => {
    const dagPath = await writeDag(makeFixtureDag());
    const lockPath = dispatchLockPath(dagPath);
    const held = acquireDispatchLock(lockPath, 'first-run');
    const runner = new MockAgentRunner({ debugDir: path.join(TMP_ROOT, 'mock-debug') });
    try {
      await expect(runCycleCore(dagPath, false, runner)).rejects.toBeInstanceOf(DuplicateDispatchError);
      expect(runner.firedUnits).toEqual([]); // refused BEFORE any unit was fired
    } finally {
      held.release();
    }
    const result = await runCycleCore(dagPath, false, runner);
    expect(result.persisted).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // the run released its lock in `finally`
    runner.cleanup();
  });

  it('d794287f D-AC3 NEGATIVE CONTROL: distinct dag files never block each other', async () => {
    const a = await writeDag(makeFixtureDag());
    const b = await writeDag(makeFixtureDag());
    expect(dispatchLockPath(a)).not.toBe(dispatchLockPath(b));
    const held = acquireDispatchLock(dispatchLockPath(a), 'run-a');
    try {
      const runner = new MockAgentRunner({ debugDir: path.join(TMP_ROOT, 'mock-debug-b') });
      await expect(runCycleCore(b, false, runner)).resolves.toBeDefined();
      runner.cleanup();
    } finally {
      held.release();
    }
  });
});
