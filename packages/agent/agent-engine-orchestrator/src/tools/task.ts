import PQueue from 'p-queue';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { BackgroundQueue } from '../engine/queue.js';
import type { DagEngine } from '../engine/dag-engine.js';
import type { Orchestrator } from '../engine/orchestrator.js';
import { resolveHitl } from '../engine/orchestrator.js';
import type { PolicyEngine } from '../engine/policy.js';
import type {
  InProcessToolDescriptor,
  InProcessToolHandler,
} from '../clients/in-process.js';
import { createProvider } from '../providers/factory.js';
import type { AgentStore } from './agent-crud.js';
import type { SessionStoreForTool } from './session.js';
import { McpClientRegistry } from '../clients/registry.js';
import type { TaskStatus } from '@adhd/agent-base-types';
import type {
  ExecutionContext,
  ResultInput,
  Task,
  TaskCancelInput,
  TaskListInput,
  TaskToolInput,
  TaskToolOutput,
  TaskUsageReport,
  TasksBatchInput,
  TasksBatchOutput,
} from '../validation/index.js';
import { ToolError } from '../validation/errors.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';
import type { IHookRegistry } from '@adhd/agent-base-types';
import { buildTaskUsageReport, type Database } from './usage.js';

export interface TaskStore {
    create(input: {
        id?: string;
        sessionId: string | null;
        prompt: string;
        parentTaskId?: string;
        recursionDepth?: number;
        dependsOn?: string[];
        onUpstreamFailure?: "fail" | "skip";
        isEphemeral?: boolean;
    }): { id: string; status: string; result?: string; error?: string };
    read(taskId: string): { id: string; status: string; result?: string; error?: string; sessionId?: string | null; isEphemeral?: boolean; prompt: string; recursionDepth: number; inputs?: Record<string, string> | null };
    updateStatus(taskId: string, status: string, fields?: Record<string, unknown>): void;
    list(filter: TaskListInput): Task[];
    cancel(taskId: string): void;
    registerCancellation(taskId: string, controller: AbortController): void;
    unregisterCancellation(taskId: string): void;
    appendEvent(evt: { taskId: string; type: string; payload?: unknown }): void;
}

export interface TaskDeps {
  agentStore: AgentStore;
  sessionStore: SessionStoreForTool;
  taskStore: TaskStore;
  orchestrator: Orchestrator;
  queue: BackgroundQueue;
  policy: PolicyEngine;
  hooks: IHookRegistry;
  selfUrl: string | undefined;
  inProcessDescriptors: InProcessToolDescriptor[];
  inProcessHandler: InProcessToolHandler;
  db: Database;
  dagEngine: DagEngine;
  config: EngineConfig;
  logger: EngineLogger;
  emitTaskEvent?: (event: { type: string; taskId: string; status?: string; result?: string | null; error?: string | null; toolName?: string; toolCallId?: string; input?: unknown; content?: unknown }) => void;
}

async function runEphemeralTask(
  input: {
    agent_name: string;
    prompt: string;
    depends_on?: string[];
    on_upstream_failure?: 'fail' | 'skip';
  },
  deps: TaskDeps,
  callerContext?: ExecutionContext
): Promise<TaskToolOutput> {
  const agentDefinition = deps.agentStore.read(input.agent_name);

  const taskId = generateId();
  const ephemeralSessionId = generateId();
  const rootTaskId = callerContext
    ? callerContext.rootTaskId ?? callerContext.taskId
    : undefined;

  if (input.depends_on && input.depends_on.length > 0) {
    deps.dagEngine.validateNoCycle(taskId, input.depends_on);
  }

  deps.taskStore.create({
    id: taskId,
    sessionId: ephemeralSessionId,
    isEphemeral: true,
    prompt: input.prompt,
    parentTaskId: callerContext?.taskId,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
    // Composition with the DAG ordering fields is recorded for ephemeral
    // tasks too (backlog 05cc1db4): `tasks_batch` enforces the ordering with
    // its wave scheduler, and the record must still reflect the declared
    // upstreams so the batch is not a silent no-op for depends_on.
    dependsOn:
      input.depends_on && input.depends_on.length > 0
        ? input.depends_on
        : undefined,
    onUpstreamFailure: input.on_upstream_failure,
  });

  const executionContext: ExecutionContext = {
    taskId,
    sessionId: ephemeralSessionId,
    agentName: agentDefinition.name,
    agentDefinition,
    callingAgentName: callerContext?.agentName,
    parentTaskId: callerContext?.taskId,
    rootTaskId: rootTaskId ?? undefined,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
    toolCallCount: 0,
  };

  const provider = createProvider(
    agentDefinition.provider,
    agentDefinition.mcpServers,
    deps.config,
    deps.logger
  );

  const userMessage = {
    id: generateId(),
    sessionId: ephemeralSessionId,
    role: 'user' as const,
    content: input.prompt,
    createdAt: nowIso(),
  };
  const messages = agentDefinition.systemPrompt
    ? [
        {
          id: generateId(),
          sessionId: ephemeralSessionId,
          role: 'system' as const,
          content: agentDefinition.systemPrompt,
          createdAt: nowIso(),
        },
        userMessage,
      ]
    : [userMessage];

  const noopSessionStore = {
    appendMessage: async () => {},
    close: () => {},
  };

  const registry = new McpClientRegistry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentDefinition.mcpServers as any,
    deps.selfUrl,
    deps.inProcessDescriptors,
    deps.inProcessHandler,
    executionContext
  );

  const controller = new AbortController();
  deps.taskStore.registerCancellation(taskId, controller);

  try {
    await deps.orchestrator.run({
      executionContext,
      messages,
      registry,
      provider,
      policy: deps.policy,
      taskStore: deps.taskStore,
      sessionStore: noopSessionStore,
      signal: controller.signal,
      taskId,
      hooks: deps.hooks,
      isEphemeral: true,
      emitTaskEvent: deps.emitTaskEvent,
      logger: deps.logger,
      config: deps.config,
    });
  } catch {
    // Orchestrator already updated status via deps.taskStore
  } finally {
    deps.taskStore.unregisterCancellation(taskId);
  }

  const finalTask = deps.taskStore.read(taskId);
  const usage = buildTaskUsageReport(deps.db, taskId);

  return {
    task_id: taskId,
    status: finalTask.status as TaskStatus,
    result: finalTask.result,
    usage,
  };
}

export async function taskTool(
  input: TaskToolInput,
  deps: TaskDeps,
  callerContext?: ExecutionContext
): Promise<TaskToolOutput> {
  if ('agent_name' in input) {
    return runEphemeralTask(input, deps, callerContext);
  }

  const session = deps.sessionStore.read(input.session_id);
  if (session.status !== 'active') {
    throw new ToolError(
      'SESSION_CLOSED',
      `Session '${input.session_id}' is closed`
    );
  }

  const agentDefinition = deps.sessionStore.getAgentDefinition(
    input.session_id
  );

  const dependsOn = (input as { depends_on?: string[] }).depends_on ?? [];
  const onUpstreamFailure = (input as { on_upstream_failure?: 'fail' | 'skip' })
    .on_upstream_failure;
  const newTaskId = generateId();
  if (dependsOn.length > 0) {
    deps.dagEngine.validateNoCycle(newTaskId, dependsOn);
  }

  const task = deps.taskStore.create({
    id: newTaskId,
    sessionId: input.session_id,
    prompt: input.prompt,
    parentTaskId: callerContext?.taskId,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    onUpstreamFailure,
  });

  const rootTaskId = callerContext
    ? callerContext.rootTaskId ?? callerContext.taskId
    : undefined;

  const executionContext: ExecutionContext = {
    taskId: task.id,
    sessionId: input.session_id,
    agentName: agentDefinition.name,
    agentDefinition,
    callingAgentName: callerContext?.agentName,
    parentTaskId: callerContext?.taskId,
    rootTaskId: rootTaskId ?? undefined,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
    toolCallCount: 0,
  };

  const controller = new AbortController();
  deps.taskStore.registerCancellation(task.id, controller);

  const provider = createProvider(
    agentDefinition.provider,
    agentDefinition.mcpServers,
    deps.config,
    deps.logger
  );

  const existingMessages = deps.sessionStore.getMessages(input.session_id);
  const userMessage = {
    id: generateId(),
    sessionId: input.session_id,
    role: 'user' as const,
    content: input.prompt,
    createdAt: nowIso(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (deps.sessionStore as any).appendMessage(input.session_id, userMessage);
  const messages = [...existingMessages, userMessage] as unknown as Message[];

  const allMessages = agentDefinition.systemPrompt
    ? [
        {
          id: generateId(),
          sessionId: input.session_id,
          role: 'system' as const,
          content: agentDefinition.systemPrompt,
          createdAt: nowIso(),
        },
        ...messages,
      ]
    : messages;

  const registry = new McpClientRegistry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentDefinition.mcpServers as any,
    deps.selfUrl,
    deps.inProcessDescriptors,
    deps.inProcessHandler,
    executionContext
  );

  const runTask = async (): Promise<void> => {
    try {
      await deps.orchestrator.run({
        executionContext,
        messages: allMessages,
        registry,
        provider,
        policy: deps.policy,
        taskStore: deps.taskStore,
        sessionStore: deps.sessionStore as unknown as import('../engine/orchestrator.js').OrchestratorSessionStore,
        signal: controller.signal,
        taskId: task.id,
        hooks: deps.hooks,
        emitTaskEvent: deps.emitTaskEvent,
        logger: deps.logger,
        config: deps.config,
      });
    } finally {
      await deps.dagEngine.dispatchReady(task.id);
    }
  };

  const sseBaseUrl = deps.config.sse.baseUrl;
  const streamUrl =
    input.stream && input.background
      ? `${sseBaseUrl}/tasks/${task.id}/stream`
      : undefined;

  if (input.background) {
    deps.queue.enqueue(task.id, runTask);

    deps.logger.info(
      { taskId: task.id, sessionId: input.session_id },
      'Task enqueued for background execution'
    );

    const response: TaskToolOutput = {
      task_id: task.id,
      status: 'pending',
    };
    if (streamUrl) {
      response.stream_url = streamUrl;
    }
    return response;
  } else {
    try {
      await runTask();
    } catch (error) {
      // Orchestrator already updated the task status
    }

    const finalTask = deps.taskStore.read(task.id);
    const usage = buildTaskUsageReport(deps.db, finalTask.id);
    const response: TaskToolOutput = {
      task_id: finalTask.id,
    status: finalTask.status as TaskStatus,
      result: finalTask.result,
      usage,
    };
    if (streamUrl) {
      response.stream_url = streamUrl;
    }
    return response;
  }
}

/** Default `tasksBatch` concurrency when the caller omits `concurrency`. */
export const DEFAULT_BATCH_CONCURRENCY = 4;

/**
 * Native bulk/parallel task-dispatch primitive (backlog 05cc1db4).
 *
 * Dispatches every prompt in `input.prompts` through the same `taskTool`
 * path a single call would use, executing at most `input.concurrency` at
 * once and returning `{index, task_id, status, result?}` per prompt so the
 * caller never has to maintain a session_id↔task_id mapping by hand.
 *
 * Ordering composes with the existing DAG fields:
 * - `depends_on[i]` — pre-existing upstream task ids for item `i`.
 * - `depends_on_indexes[i]` — indexes of EARLIER items in this same batch;
 *   resolved to their generated task ids and threaded through as
 *   `depends_on`, so a later item is only started after the earlier one
 *   completes (wave scheduling — a deterministic topological order).
 * - `on_upstream_failure[i]` — per-item upstream-failure policy.
 *
 * A task's own execution failure is not a batch failure: `taskTool` records
 * it as `status: 'failed'` and it is returned in that item's result. Only a
 * validation-level failure (e.g. a session closed before dispatch) rejects.
 */
export async function tasksBatch(
  input: TasksBatchInput,
  deps: TaskDeps,
  callerContext?: ExecutionContext
): Promise<TasksBatchOutput> {
  const concurrency = input.concurrency ?? DEFAULT_BATCH_CONCURRENCY;
  const n = input.prompts.length;

  const taskIds = new Array<string | undefined>(n);
  const results = new Array<TasksBatchOutput['results'][number]>(n);
  const completed = new Set<number>();
  const started = new Set<number>();
  const queue = new PQueue({ concurrency });

  const runItem = async (i: number): Promise<void> => {
    const upstream = (input.depends_on?.[i] ?? []).slice();
    for (const j of input.depends_on_indexes?.[i] ?? []) {
      const upstreamId = taskIds[j];
      if (!upstreamId) {
        throw new ToolError(
          'VALIDATION_ERROR',
          `tasks_batch: item ${i} depends on index ${j}, which has not produced a task yet`
        );
      }
      upstream.push(upstreamId);
    }

    const onUpstreamFailure = input.on_upstream_failure?.[i];
    const base = {
      prompt: input.prompts[i],
      background: false,
      ...(upstream.length > 0 ? { depends_on: upstream } : {}),
      ...(onUpstreamFailure ? { on_upstream_failure: onUpstreamFailure } : {}),
    };
    const itemInput = input.session_ids
      ? ({ session_id: input.session_ids[i], ...base } as TaskToolInput)
      : ({ agent_name: input.agent_name as string, ...base } as TaskToolInput);

    const out = await taskTool(itemInput, deps, callerContext);
    taskIds[i] = out.task_id;
    results[i] = {
      index: i,
      task_id: out.task_id,
      status: out.status,
      ...(out.result !== undefined ? { result: out.result } : {}),
    };
  };

  // Wave scheduler: each wave runs every item whose intra-batch dependencies
  // have completed, bounded by `concurrency`. Because `depends_on_indexes`
  // only references earlier indexes, the graph is acyclic and every item is
  // eventually ready.
  while (completed.size < n) {
    const ready: number[] = [];
    for (let i = 0; i < n; i++) {
      if (completed.has(i) || started.has(i)) continue;
      const idxDeps = input.depends_on_indexes?.[i] ?? [];
      if (idxDeps.every((j) => completed.has(j))) ready.push(i);
    }
    if (ready.length === 0) {
      throw new ToolError(
        'VALIDATION_ERROR',
        'tasks_batch: unsatisfiable dependency graph among depends_on_indexes'
      );
    }
    for (const i of ready) started.add(i);
    await Promise.all(ready.map((i) => queue.add(() => runItem(i))));
    for (const i of ready) completed.add(i);
  }

  return { concurrency, results };
}

export async function enqueueExistingTask(
  taskId: string,
  deps: TaskDeps
): Promise<void> {
  const task = deps.taskStore.read(taskId);

  if (task.isEphemeral || !task.sessionId) {
    deps.logger.warn(
      { taskId, isEphemeral: task.isEphemeral },
      'enqueueExistingTask: skipping ephemeral task — context lost on restart'
    );
    try {
      deps.taskStore.updateStatus(taskId, 'failed', {
        error:
          'Ephemeral task context lost on server restart; create a new task.',
      });
    } catch {
      // Already in a terminal state — ignore
    }
    return;
  }

  const session = deps.sessionStore.read(task.sessionId);

  if (session.status !== 'active') {
    deps.logger.warn(
      { taskId, sessionId: task.sessionId },
      'enqueueExistingTask: session is not active, skipping dispatch'
    );
    return;
  }

  const agentDefinition = deps.sessionStore.getAgentDefinition(task.sessionId);

  const executionContext: ExecutionContext = {
    taskId,
    sessionId: task.sessionId,
    agentName: agentDefinition.name,
    agentDefinition,
    recursionDepth: task.recursionDepth,
    toolCallCount: 0,
    inputs: task.inputs ?? undefined,
  };

  const controller = new AbortController();
  deps.taskStore.registerCancellation(taskId, controller);

  const provider = createProvider(
    agentDefinition.provider,
    agentDefinition.mcpServers,
    deps.config,
    deps.logger
  );

  const existingMessages = deps.sessionStore.getMessages(task.sessionId);
  const userMessage = {
    id: generateId(),
    sessionId: task.sessionId,
    role: 'user' as const,
    content: task.prompt,
    createdAt: nowIso(),
  };
  const messages = [...existingMessages, userMessage] as unknown as Message[];

  const allMessages = agentDefinition.systemPrompt
    ? [
        {
          id: generateId(),
          sessionId: task.sessionId,
          role: 'system' as const,
          content: agentDefinition.systemPrompt,
          createdAt: nowIso(),
        },
        ...messages,
      ]
    : messages;

  const registry = new McpClientRegistry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentDefinition.mcpServers as any,
    deps.selfUrl,
    deps.inProcessDescriptors,
    deps.inProcessHandler,
    executionContext
  );

  deps.queue.enqueue(taskId, async () => {
    try {
      await deps.orchestrator.run({
        executionContext,
        messages: allMessages,
        registry,
        provider,
        policy: deps.policy,
        taskStore: deps.taskStore,
        sessionStore: deps.sessionStore as unknown as import('../engine/orchestrator.js').OrchestratorSessionStore,
        signal: controller.signal,
        taskId,
        hooks: deps.hooks,
        emitTaskEvent: deps.emitTaskEvent,
        logger: deps.logger,
        config: deps.config,
      });
    } finally {
      await deps.dagEngine.dispatchReady(taskId);
    }
  });
}

export function taskList(
  input: TaskListInput,
  deps: Pick<TaskDeps, 'taskStore'>
): Task[] {
  return deps.taskStore.list(input);
}

export function taskCancel(
  input: TaskCancelInput,
  deps: Pick<TaskDeps, 'taskStore'>
): { success: true } {
  const task = deps.taskStore.read(input.task_id);

  const cancellableStatuses = ['pending', 'running', 'awaiting_input'] as const;
  if (
    !cancellableStatuses.includes(
      task.status as (typeof cancellableStatuses)[number]
    )
  ) {
    throw new ToolError(
      'TASK_NOT_CANCELLABLE',
      `Task '${input.task_id}' has status '${task.status}' and cannot be cancelled`
    );
  }

  deps.taskStore.cancel(input.task_id);
  return { success: true };
}

export async function taskResume(
  input: { taskId: string; resumeToken: string; userInput: string },
  deps: Pick<TaskDeps, 'taskStore'>
): Promise<{ success: true; taskId: string }> {
  const task = deps.taskStore.read(input.taskId);

  if (task.status !== 'awaiting_input') {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Task '${input.taskId}' is not awaiting input (status: ${task.status})`
    );
  }

  if ((task as unknown as { resumeToken?: string }).resumeToken !== input.resumeToken) {
    throw new ToolError('VALIDATION_ERROR', 'Invalid resumeToken');
  }

  const resolved = resolveHitl(input.taskId, input.userInput);
  if (!resolved) {
    deps.taskStore.updateStatus(input.taskId, 'failed', {
      error:
        'Task could not be resumed: server restarted while task was suspended. Create a new task.',
    });
    throw new ToolError(
      'TASK_NOT_RESUMABLE',
      `Task '${input.taskId}' has no active suspension (process restarted; task has been failed)`
    );
  }

  return { success: true, taskId: input.taskId };
}

export function resultTool(
  input: ResultInput,
  deps: Pick<TaskDeps, 'taskStore' | 'db'>
): Task & { usage?: TaskUsageReport } {
  const task = deps.taskStore.read(input.task_id);
  const usage = buildTaskUsageReport(deps.db, task.id);
  return { ...task, usage } as Task & { usage?: TaskUsageReport };
}

// Import Message for type used above
import type { Message } from '../validation/index.js';
