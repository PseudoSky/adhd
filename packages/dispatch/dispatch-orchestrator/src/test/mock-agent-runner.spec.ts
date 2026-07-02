import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAgentRunner } from './helpers/mock-agent-runner.js';
import { makeUnit } from './helpers/fixtures.js';

// Namespaced under tmp/ per CLAUDE.md's "one canonical root" convention, and
// kept separate from MockAgentRunner's own default debugDir
// (tmp/dispatch-orchestrator/mock-debug) so this suite's fixtures never
// collide with a run that uses unconfigured defaults.
const scratchDir = join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator-test',
  'mock-agent-runner'
);

describe('MockAgentRunner', () => {
  let runner: MockAgentRunner | undefined;

  afterEach(() => {
    // (b) cleanup of tmp output in teardown — no test in this file leaves
    // anything behind under tmp/, regardless of which debugDir it used.
    runner?.cleanup();
    runner = undefined;
  });

  describe('fire — debug file', () => {
    it('writes the compiled prompt to <debugDir>/agent-<slug>.md with an identifying header', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });
      const unit = makeUnit({
        agent_name: 'workflow-researcher',
        id: 'unit-a',
        milestones: ['embedding-approach-decided'],
        prompt: 'COMPILED PROMPT BODY',
      });

      await runner.fire(unit);

      const filePath = join(scratchDir, 'agent-workflow-researcher.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('Agent: workflow-researcher');
      expect(content).toContain('Unit: unit-a');
      expect(content).toContain('Milestones: embedding-approach-decided');
      expect(content).toContain('COMPILED PROMPT BODY');
    });

    it('sanitizes agent names with filename-unsafe characters', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });

      await runner.fire(
        makeUnit({ agent_name: 'workflow:plan-orchestrator', prompt: 'x' })
      );

      expect(
        existsSync(join(scratchDir, 'agent-workflow-plan-orchestrator.md'))
      ).toBe(true);
    });

    it('is deterministic — the same unit always produces byte-identical file content', async () => {
      const unit = makeUnit({
        agent_name: 'workflow-researcher',
        id: 'unit-det',
        prompt: 'STABLE PROMPT\nwith multiple lines',
      });
      const filePath = join(scratchDir, 'agent-workflow-researcher.md');

      runner = new MockAgentRunner({ debugDir: scratchDir });
      await runner.fire(unit);
      const first = readFileSync(filePath, 'utf8');

      // Same instance, re-fired.
      await runner.fire(unit);
      expect(readFileSync(filePath, 'utf8')).toBe(first);

      // Fresh instance, same unit.
      const otherRunner = new MockAgentRunner({ debugDir: scratchDir });
      await otherRunner.fire(unit);
      expect(readFileSync(filePath, 'utf8')).toBe(first);
    });

    it('derives taskId deterministically from unit.id, never randomly', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });
      const { taskId: first } = await runner.fire(
        makeUnit({ id: 'unit-fixed', prompt: 'p' })
      );

      const otherRunner = new MockAgentRunner({ debugDir: scratchDir });
      const { taskId: second } = await otherRunner.fire(
        makeUnit({ id: 'unit-fixed', prompt: 'p' })
      );

      expect(first).toBe(second);
    });

    it('throws without writing anything when unit.prompt is null', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });

      await expect(
        runner.fire(makeUnit({ prompt: null }))
      ).rejects.toThrow(/no compiled prompt/);
      expect(existsSync(scratchDir)).toBe(false);
    });
  });

  describe('default debugDir', () => {
    it('defaults to tmp/dispatch-orchestrator/mock-debug, following the tmp/<package>/… convention', async () => {
      runner = new MockAgentRunner();

      await runner.fire(
        makeUnit({ agent_name: 'default-dir-probe', prompt: 'p' })
      );

      const expectedPath = join(
        process.cwd(),
        'tmp',
        'dispatch-orchestrator',
        'mock-debug',
        'agent-default-dir-probe.md'
      );
      expect(existsSync(expectedPath)).toBe(true);
    });
  });

  describe('ensureAgent', () => {
    it('records the call in order without touching disk', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });
      const unitA = makeUnit({ id: 'unit-a' });
      const unitB = makeUnit({ id: 'unit-b' });

      await runner.ensureAgent(unitA);
      await runner.ensureAgent(unitB);

      expect(runner.ensureAgentCalls).toEqual([unitA, unitB]);
      expect(existsSync(scratchDir)).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns the deterministic default canned result for an unconfigured agent', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });
      const { taskId } = await runner.fire(
        makeUnit({ agent_name: 'agent-x', prompt: 'p' })
      );

      const result = await runner.poll(taskId);

      expect(result.status).toBe('completed');
      expect(result.usage?.direct.modelCalls).toBe(1);
      expect(result.usage?.direct.inputTokens).toBeGreaterThan(0);
    });

    it('returns the per-agent scripted result when configured (e.g. to simulate a guard-failing run)', async () => {
      runner = new MockAgentRunner({
        debugDir: scratchDir,
        resultsByAgent: {
          'flaky-agent': { status: 'failed' },
        },
      });
      const { taskId } = await runner.fire(
        makeUnit({ agent_name: 'flaky-agent', prompt: 'p' })
      );

      const result = await runner.poll(taskId);

      expect(result.status).toBe('failed');
    });

    it('throws for an unknown taskId', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });

      await expect(runner.poll('never-fired')).rejects.toThrow(
        /unknown taskId/
      );
    });
  });

  describe('cancel', () => {
    it('marks a fired task cancelled so a subsequent poll reflects it', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });
      const { taskId } = await runner.fire(makeUnit({ prompt: 'p' }));

      await runner.cancel(taskId);
      const result = await runner.poll(taskId);

      expect(result.status).toBe('cancelled');
    });

    it('throws for an unknown taskId', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });

      await expect(runner.cancel('never-fired')).rejects.toThrow(
        /unknown taskId/
      );
    });
  });

  describe('cleanup', () => {
    it('removes debugDir recursively', async () => {
      runner = new MockAgentRunner({ debugDir: scratchDir });
      await runner.fire(makeUnit({ prompt: 'p' }));
      expect(existsSync(scratchDir)).toBe(true);

      runner.cleanup();

      expect(existsSync(scratchDir)).toBe(false);
    });

    it('also removes now-empty ancestor directories, but never tmp/ itself', async () => {
      // scratchDir's parent (tmp/dispatch-orchestrator-test) exists ONLY as
      // a side effect of firing into scratchDir and holds nothing else — a
      // correct cleanup() must remove it too. This assertion FAILS against a
      // cleanup() that only rmSync's the leaf debugDir (the prior
      // implementation): that version never climbed past debugDir, so this
      // parent survived as an empty directory. Verified by temporarily
      // reverting to the leaf-only cleanup() and re-running this test — see
      // the milestone report for the captured red/green output.
      const scratchParent = join(
        process.cwd(),
        'tmp',
        'dispatch-orchestrator-test'
      );
      const tmpRoot = join(process.cwd(), 'tmp');

      runner = new MockAgentRunner({ debugDir: scratchDir });
      await runner.fire(makeUnit({ prompt: 'p' }));
      expect(existsSync(scratchParent)).toBe(true);

      runner.cleanup();

      expect(existsSync(scratchParent)).toBe(false);
      expect(existsSync(tmpRoot)).toBe(true);
    });

    it('stops climbing at an ancestor that still holds other content', async () => {
      // A sibling file inside scratchDir's parent means the parent is NOT
      // provably empty after cleanup() removes the leaf — cleanup() must
      // leave it (and the sibling) alone rather than force-deleting.
      const scratchParent = join(
        process.cwd(),
        'tmp',
        'dispatch-orchestrator-test'
      );
      const siblingFile = join(scratchParent, 'someone-elses-file.txt');

      runner = new MockAgentRunner({ debugDir: scratchDir });
      await runner.fire(makeUnit({ prompt: 'p' }));
      writeFileSync(siblingFile, 'not mine', 'utf8');

      runner.cleanup();

      expect(existsSync(scratchDir)).toBe(false); // leaf still removed
      expect(existsSync(siblingFile)).toBe(true); // sibling untouched
      unlinkSync(siblingFile); // manual teardown — this file isn't ours to leave for afterEach
      rmdirSync(scratchParent);
    });
  });
});
