import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type {
  DispatchTaskStatus,
  DispatchUsageReport,
  IDispatchAgentRunner,
} from '../../lib/agent-runner.js';

/** Canned outcome `poll()` returns for a task fired against a given agent. */
export interface MockTaskResult {
  status: DispatchTaskStatus;
  usage?: DispatchUsageReport;
}

export interface MockAgentRunnerOptions {
  /**
   * Directory the compiled prompt is written to on `fire()`. Defaults to
   * `tmp/dispatch-orchestrator/mock-debug` relative to `process.cwd()`,
   * following the repo's `tmp/<package>/…` convention (CLAUDE.md "Test/
   * ephemeral artifacts"). Override for test isolation — see `cleanup()`.
   */
  debugDir?: string;
  /**
   * Per-`unit.agent_name` canned `poll()` outcome. Lets a caller script a
   * specific result (e.g. a guard-failing artifact) for one agent without
   * affecting others — the tests-real-e2e milestone's later scenarios need
   * this kind of per-agent scripting; this seam only provides the knob, not
   * scenario-specific behavior.
   */
  resultsByAgent?: Record<string, MockTaskResult>;
  /** Fallback `poll()` outcome for agents with no entry in `resultsByAgent`. */
  defaultResult?: MockTaskResult;
}

const DEFAULT_DEBUG_DIR = join(
  process.cwd(),
  'tmp',
  'dispatch-orchestrator',
  'mock-debug'
);

const DEFAULT_TASK_RESULT: MockTaskResult = {
  status: 'completed',
  usage: {
    direct: {
      inputTokens: 100,
      outputTokens: 50,
      modelCalls: 1,
      toolCallCount: 0,
      latencyMs: 500,
    },
    subtree: {
      inputTokens: 100,
      outputTokens: 50,
      modelCalls: 1,
      toolCallCount: 0,
      latencyMs: 500,
    },
    taskCount: 1,
  },
};

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

interface FiredTask {
  unit: DispatchUnit;
  result: MockTaskResult;
  cancelled: boolean;
}

/**
 * `IDispatchAgentRunner` test double — never calls a real LLM. Fully
 * deterministic: no timers, no randomness, no wall-clock reads. Writes the
 * compiled prompt for the most recent fire of a given agent to
 * `<debugDir>/agent-<slug>.md` so a human (or a snapshot test) can inspect
 * exactly what the orchestrator would have sent — see dag.json operation
 * agent-runner.2 and docs/plan/dispatch-completion/superseded/dispatch-production/contexts/tests-real-e2e.md.
 */
export class MockAgentRunner implements IDispatchAgentRunner {
  /** Every unit passed to `ensureAgent()`, in call order. */
  readonly ensureAgentCalls: DispatchUnit[] = [];
  /** Every unit passed to `fire()`, in call order. */
  readonly firedUnits: DispatchUnit[] = [];

  private readonly debugDir: string;
  private readonly resultsByAgent: Record<string, MockTaskResult>;
  private readonly defaultResult: MockTaskResult;
  private readonly tasks = new Map<string, FiredTask>();

  constructor(options: MockAgentRunnerOptions = {}) {
    this.debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
    this.resultsByAgent = options.resultsByAgent ?? {};
    this.defaultResult = options.defaultResult ?? DEFAULT_TASK_RESULT;
  }

  async ensureAgent(unit: DispatchUnit): Promise<void> {
    this.ensureAgentCalls.push(unit);
  }

  async fire(unit: DispatchUnit): Promise<{ taskId: string }> {
    if (unit.prompt == null) {
      throw new Error(
        `DispatchUnit '${unit.id}' has no compiled prompt (prompt is null) — cannot fire`
      );
    }

    mkdirSync(this.debugDir, { recursive: true });
    const filePath = join(
      this.debugDir,
      `agent-${slugify(unit.agent_name)}.md`
    );
    const header = [
      `# Agent: ${unit.agent_name}`,
      '',
      `Unit: ${unit.id}`,
      `Milestones: ${unit.milestones.join(', ')}`,
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(filePath, header + unit.prompt + '\n', 'utf8');

    // Deterministic by construction: derived from unit.id, never random or
    // time-based, so re-firing the same unit is fully reproducible.
    const taskId = `mock-task-${unit.id}`;
    const result = this.resultsByAgent[unit.agent_name] ?? this.defaultResult;
    this.tasks.set(taskId, { unit, result, cancelled: false });
    this.firedUnits.push(unit);

    return { taskId };
  }

  async poll(
    taskId: string
  ): Promise<{ status: DispatchTaskStatus; usage: DispatchUsageReport | undefined }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`MockAgentRunner.poll: unknown taskId '${taskId}' (never fired)`);
    }
    if (task.cancelled) {
      return { status: 'cancelled', usage: task.result.usage };
    }
    return { status: task.result.status, usage: task.result.usage };
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`MockAgentRunner.cancel: unknown taskId '${taskId}' (never fired)`);
    }
    task.cancelled = true;
  }

  /**
   * Test convenience: removes `debugDir` recursively, then climbs and
   * removes now-empty ancestor directories so no residue survives — e.g.
   * firing into `tmp/<package>/mock-debug/` also removes `tmp/<package>/`
   * once it's empty. Not part of `IDispatchAgentRunner` — tests call this in
   * `afterEach`/`afterAll`.
   *
   * The climb stops the instant an ancestor is non-empty (another consumer
   * still owns files there) or at the repo's `tmp/` root itself, which is
   * never removed — `tmp/` is shared across every package's tests, so only
   * directories this instance created (and are provably empty) are deleted.
   */
  cleanup(): void {
    rmSync(this.debugDir, { recursive: true, force: true });

    const tmpRoot = join(process.cwd(), 'tmp');
    let dir = dirname(this.debugDir);
    while (dir !== tmpRoot && dir.startsWith(tmpRoot + sep)) {
      try {
        rmdirSync(dir);
      } catch {
        break; // ENOTEMPTY (another consumer's files) or already gone — stop climbing
      }
      dir = dirname(dir);
    }
  }
}
