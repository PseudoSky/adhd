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
  input: { agent_name: string; prompt: string },
  deps: TaskDeps,
  callerContext?: ExecutionContext
): Promise<TaskToolOutput> {
  const agentDefinition = deps.agentStore.read(input.agent_name);

  const taskId = generateId();
  const ephemeralSessionId = generateId();
  const rootTaskId = callerContext
    ? callerContext.rootTaskId ?? callerContext.taskId
    : undefined;

  deps.taskStore.create({
    id: taskId,
    sessionId: ephemeralSessionId,
    isEphemeral: true,
    prompt: input.prompt,
    parentTaskId: callerContext?.taskId,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
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
