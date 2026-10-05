/**
 * hitl-suspension.spec.ts — deterministic, NON-PAID end-to-end proof that a
 * sessioned dispatch task which suspends for human input (HITL) is (a) parked
 * at `awaiting_input`, (b) surfaced by `dispatch-cli status` with the resume
 * token, and (c) completable via agent-mcp's `task_resume` (backlog 03145a46).
 *
 * Real components throughout: real `runCycleCore` → real `orchestrateCycle` →
 * real `AgentMcpRunner` → real `DagClient`/snapshot/optimize → real
 * `statusCore`. It also proves the reconciliation follow-up (48b14ec1): after
 * the resumed task completes, a subsequent cycle reconciles it back into the
 * DAG (runs the milestone guard, marks the milestone complete) and `statusCore`
 * stops reporting `awaiting_input`.
 *
 * The ONLY double is the MCP client (`IMcpToolClient`): the
 * external agent-mcp boundary, whose real form spawns a child and calls a paid
 * model. The live equivalent (`live-dispatch-five-acs.e2e.test.ts`, env-gated)
 * drives the REAL agent-mcp + real model; this test proves the same mechanics
 * deterministically and by default.
 *
 * NEGATIVE CONTROL (teeth): the fake `task` handler rejects any call that lacks
 * `background:true` with the MCP client's request-timeout error (`-32001`) —
 * exactly what aborts a synchronous sessioned call once the engine blocks on
 * `await userInputPromise`. So reverting `AgentMcpRunner.fire`'s
 * `background:true` makes `runCycleCore` record a failed entry (not a
 * suspension) and this test's `awaiting_input` assertions go red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  AgentMcpRunner,
  type IMcpToolClient,
  type McpCallToolResult,
} from '@adhd/dispatch-orchestrator';

import { runCycleCore, statusCore } from '../lib/core.js';
import { makeFixtureDag } from './helpers/fixtures.js';

const TMP_ROOT = path.join(
  process.cwd(),
  'tmp',
  'dispatch-cli',
  'hitl-suspension-spec'
);

beforeAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
});
afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const TASK_ID = '66666666-6666-4666-8666-666666666666';
const RESUME_TOKEN = '77777777-7777-4777-8777-777777777777';

/**
 * A minimal in-process agent-mcp stand-in over the real `IMcpToolClient` seam.
 * Encodes responses exactly as the SDK client does (JSON text content), so
 * `AgentMcpRunner`'s own wire parsing is exercised.
 */
class FakeHitlMcpClient implements IMcpToolClient {
  readonly taskArgs: Record<string, unknown>[] = [];
  connected = 0;
  closed = 0;
  private resumed = false;

  async connect(): Promise<void> {
    this.connected++;
  }
  async close(): Promise<void> {
    this.closed++;
  }

  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult> {
    const args = params.arguments ?? {};
    switch (params.name) {
      case 'agent_read':
        return ok({ name: args['name'] });
      case 'task': {
        this.taskArgs.push(args);
        if (args['background'] !== true) {
          // The real MCP client abort for a synchronous sessioned call that
          // blocks past its request timeout. A client-side abort rejects the
          // callTool promise, so reject here too.
          throw new Error('MCP error -32001: Request timed out');
        }
        return ok({ task_id: TASK_ID, status: 'pending' });
      }
      case 'result':
        return ok(
          this.resumed
            ? { status: 'completed', result: 'approved and done' }
            : { status: 'awaiting_input', resumeToken: RESUME_TOKEN }
        );
      case 'task_resume':
        if (args['resumeToken'] !== RESUME_TOKEN) {
          return err('VALIDATION_ERROR', 'Invalid resumeToken');
        }
        this.resumed = true;
        return ok({ success: true, taskId: args['taskId'] });
      case 'usage_query':
        return ok({ rows: [] });
      default:
        throw new Error(`FakeHitlMcpClient: unexpected tool '${params.name}'`);
    }
  }
}

function ok(value: unknown): McpCallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
function err(code: string, message: string): McpCallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}` }],
  };
}

describe('HITL suspension surfaced by dispatch-cli status (03145a46)', () => {
  it('surfaces awaiting_input + resumeToken in statusCore and resumes to completion', async () => {
    const dir = path.join(TMP_ROOT, 'positive');
    fs.mkdirSync(dir, { recursive: true });
    const dagPath = path.join(dir, 'dag.json');
    await fs.promises.writeFile(
      dagPath,
      JSON.stringify(makeFixtureDag({ session_id: SESSION_ID }), null, 2)
    );

    const client = new FakeHitlMcpClient();
    const runner = new AgentMcpRunner({
      command: 'unused-in-test',
      clientFactory: () => client,
    });

    try {
      // Real CLI cycle path, real orchestrator, real runner — fake MCP only.
      const cycle = await runCycleCore(dagPath, false, runner);
      const hitlDispatch = cycle.dispatched.find((d) =>
        d.milestones.includes('a')
      );
      expect(hitlDispatch?.taskStatus).toBe('awaiting_input');
      // The fix: sessioned fire is background.
      expect(client.taskArgs[0]?.['background']).toBe(true);
      expect(client.taskArgs[0]?.['session_id']).toBe(SESSION_ID);

      // CONSUMER OUTCOME: `dispatch-cli status` surfaces the suspension.
      const report = await statusCore(dagPath);
      expect(report['a']?.status).toBe('awaiting_input');
      expect(report['a']?.awaitingInput).toEqual({
        taskId: TASK_ID,
        resumeToken: RESUME_TOKEN,
      });
      // Non-suspended milestones are unaffected.
      expect(report['b']?.status).toBe('pending');
      expect(report['b']?.awaitingInput).toBeUndefined();

      // `task_resume` with the surfaced token drives it to completion.
      await runner.callTool('task_resume', {
        taskId: report['a']?.awaitingInput?.taskId,
        resumeToken: report['a']?.awaitingInput?.resumeToken,
        userInput: 'approved',
      });
      const polled = await runner.poll(TASK_ID);
      expect(polled.status).toBe('completed');

      // RECONCILIATION (48b14ec1): a subsequent cycle reconciles the resumed
      // task back into the DAG — runs milestone 'a's guard and marks it
      // complete — WITHOUT re-firing the agent. This is the consumer outcome
      // the item requires: the milestone LEAVES awaiting_input.
      const cycle2 = await runCycleCore(dagPath, false, runner);
      const reconciled = cycle2.dispatched.find((d) =>
        d.milestones.includes('a')
      );
      expect(reconciled?.taskStatus).toBe('completed');
      expect(reconciled?.suspension).toBeNull();

      // `dispatch-cli status` no longer reports the stale awaiting_input.
      const report2 = await statusCore(dagPath);
      expect(report2['a']?.status).toBe('complete');
      expect(report2['a']?.awaitingInput).toBeUndefined();
    } finally {
      await runner.close();
    }
  });
});
