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
import { buildProviderForSelection, resolveTaskSelection } from '../providers/construct.js';
import type { ProviderRegistry } from '@adhd/agent-core-provider';
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
        /** Dispatching cwd (ADR-0008 D4), persisted so a redispatch keeps it (9ed453c1 CWD). */
        cwd?: string;
    }): { id: string; status: string; result?: string; error?: string };
    read(taskId: string): { id: string; status: string; result?: string; error?: string; sessionId?: string | null; isEphemeral?: boolean; prompt: string; recursionDepth: number; parentTaskId?: string; inputs?: Record<string, string> | null; cwd?: string | null };
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
  /**
   * The provider/model data registry. When present, a canonical `modelRef` is
   * resolved to its provider-native wire string at provider construction.
   */
  providerRegistry?: ProviderRegistry;
  emitTaskEvent?: (event: { type: string; taskId: string; status?: string; result?: string | null; error?: string | null; toolName?: string; toolCallId?: string; input?: unknown; content?: unknown }) => void;
}

/** Task statuses a DAG upstream will never transition out of. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * The subset of `dependsOn` whose tasks are not yet in a terminal state
 * (backlog ac115447). `depends_on` was previously recorded but never enforced,
 * so a task with unmet upstreams ran immediately. A non-empty result means the
 * task must not be dispatched: the background path leaves it `waiting` for
 * `DagEngine.dispatchReady`, and the synchronous path rejects it with a typed
 * `VALIDATION_ERROR` instead of running it early.
 *
 * An id that cannot be read (unknown upstream) is treated as unmet — it can
 * never have completed. Pure — exported for tests.
 */
export function unmetDependencies(
  dependsOn: readonly string[],
  taskStore: Pick<TaskStore, 'read'>
): string[] {
  const unmet: string[] = [];
  for (const id of dependsOn) {
    let status: string;
    try {
      status = taskStore.read(id).status;
    } catch {
      unmet.push(id);
      continue;
    }
    if (!TERMINAL_TASK_STATUSES.has(status)) unmet.push(id);
  }
  return unmet;
}

async function runEphemeralTask(
  input: {
    agent_name: string;
    prompt: string;
    depends_on?: string[];
    on_upstream_failure?: 'fail' | 'skip';
    cwd?: string;
  },
  deps: TaskDeps,
  callerContext?: ExecutionContext
): Promise<TaskToolOutput> {
  // Caller-cwd contract (ADR-0008 D4): the caller may supply a `cwd`; a
  // sub-dispatch inherits the parent's. Absent ⇒ the host falls back to its own
  // process.cwd() (flagged on the resolve context).
  const effectiveCwd = input.cwd ?? callerContext?.cwd;
  const agentDefinition = deps.agentStore.read(input.agent_name, effectiveCwd);
  // The session snapshot must be the DECLARATIVE definition (ADR-0008 D4/D8):
  // a host whose `agentStore.read` resolves the native toolset against the
  // dispatching cwd exposes `readUnresolved`, so no task-time resolved root is
  // frozen into `sessions.agent_data` and a later reuse re-resolves against its
  // own cwd. The RESOLVED definition is kept for the provider + execution context
  // (what actually runs), never for persistence.
  const snapshotDefinition =
    deps.agentStore.readUnresolved?.(input.agent_name) ?? agentDefinition;

  // Resolve the provider selection BEFORE any session/task row exists: an agent
  // with no provider and no host default is refused up front (fail closed).
  const { selection, wireModel } = resolveTaskSelection({
    agentDefinition,
    config: deps.config,
    registry: deps.providerRegistry,
  });

  const taskId = generateId();
  const rootTaskId = callerContext
    ? callerContext.rootTaskId ?? callerContext.taskId
    : undefined;

  if (input.depends_on && input.depends_on.length > 0) {
    deps.dagEngine.validateNoCycle(taskId, input.depends_on);
  }

  // Dependency gating (ac115447): an ephemeral task is always synchronous, so it
  // cannot be left `waiting` for the DAG engine — reject it rather than running
  // it before its declared upstreams. `tasks_batch`'s wave scheduler guarantees
  // every `depends_on_indexes` upstream is already terminal by dispatch time, so
  // a well-formed batch is unaffected.
  const unmet = unmetDependencies(input.depends_on ?? [], deps.taskStore);
  if (unmet.length > 0) {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Ephemeral task depends on upstream task(s) that are not yet complete: ${unmet.join(', ')}`,
      { depends_on: input.depends_on, unmet }
    );
  }

  // Every task is SESSIONED (ADR-0008 D6): a one-shot `agent_name` dispatch
  // creates a REAL session row, not a sessionless placeholder. The noop-session
  // path is retired. `isEphemeral: true` is the retention class (an ephemeral
  // session is reclaimed on terminal), NOT an interactivity/HITL property.
  const session = deps.sessionStore.create({
    agentName: agentDefinition.name,
    agentDefinition: snapshotDefinition,
  });
  const sessionId = session.id;

  deps.taskStore.create({
    id: taskId,
    sessionId,
    isEphemeral: true,
    prompt: input.prompt,
    parentTaskId: callerContext?.taskId,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
    // 9ed453c1 CWD: persist the dispatching cwd so a redispatch keeps it.
    cwd: effectiveCwd,
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
    sessionId,
    agentName: agentDefinition.name,
    agentDefinition,
    callingAgentName: callerContext?.agentName,
    parentTaskId: callerContext?.taskId,
    rootTaskId: rootTaskId ?? undefined,
    recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
    toolCallCount: 0,
    // Carry the effective cwd so a further sub-dispatch inherits it (ADR-0008 D4).
    cwd: effectiveCwd,
    selection,
    wireModel,
  };

  const provider = buildProviderForSelection({
    agentDefinition,
    selection,
    config: deps.config,
    logger: deps.logger,
    registry: deps.providerRegistry,
    hooks: deps.hooks,
    executionContext,
  });

  const userMessage = {
    id: generateId(),
    sessionId,
    role: 'user' as const,
    content: input.prompt,
    createdAt: nowIso(),
  };
  const messages = agentDefinition.systemPrompt
    ? [
        {
          id: generateId(),
          sessionId,
          role: 'system' as const,
          content: agentDefinition.systemPrompt,
          createdAt: nowIso(),
        },
        userMessage,
      ]
    : [userMessage];

  // Persist the user message to the real session (mirrors the session path) so
  // the one-shot task's transcript is complete for the retention window.
  // `appendMessage` is on the concrete SessionStore, not the minimal
  // `SessionStoreForTool` surface — same cast the session path already uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (deps.sessionStore as any).appendMessage(sessionId, userMessage);

  const registry = new McpClientRegistry(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentDefinition.mcpServers as any,
    deps.selfUrl,
    deps.inProcessDescriptors,
    deps.inProcessHandler,
    executionContext,
    deps.config,
    deps.logger
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
      sessionStore:
        deps.sessionStore as unknown as import('../engine/orchestrator.js').OrchestratorSessionStore,
      signal: controller.signal,
      taskId,
      hooks: deps.hooks,
      // A one-shot `agent_name` dispatch is SYNCHRONOUS: this call blocks until
      // `run` resolves, so the caller can never receive a resumeToken. Hence no
      // approver is reachable within the call — an `ask` must fail closed rather
      // than suspend (ADR-0008 D6: an unanswered ask never hangs).
      suspensionAnswerable: false,
      emitTaskEvent: deps.emitTaskEvent,
      logger: deps.logger,
      config: deps.config,
    });
  } catch {
    // Orchestrator already updated status via deps.taskStore
  } finally {
    deps.taskStore.unregisterCancellation(taskId);
    // Retention `ephemeral` = reclaim on terminal (ADR-0008 D6). The session
    // row is REAL (created above) and is closed once its task reaches a
    // terminal state; closing is idempotent-protected by the store (a second
    // close raises SESSION_CLOSED, which we swallow here).
    try {
      deps.sessionStore.close(sessionId);
    } catch {
      // already closed / absent — nothing to reclaim
    }
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

  // Caller-cwd contract (ADR-0008 D4): the caller may supply a `cwd` on the
  // task; a sub-dispatch inherits the parent's. Absent ⇒ host fallback (flagged).
  const effectiveCwd = input.cwd ?? callerContext?.cwd;
  const agentDefinition = deps.sessionStore.getAgentDefinition(
    input.session_id,
    effectiveCwd
  );

  // Resolve the provider selection BEFORE the task row is created (fail closed:
  // `NO_PROVIDER_SELECTED` leaves nothing half-created). The session-held
  // binding is the `session` tier of the chain.
  const { selection, wireModel } = resolveTaskSelection({
    agentDefinition,
    sessionBinding: deps.sessionStore.getSelection?.(input.session_id) ?? null,
    config: deps.config,
    registry: deps.providerRegistry,
  });

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
    // 9ed453c1 CWD: persist the dispatching cwd so a DAG/restart redispatch keeps it.
    cwd: effectiveCwd,
  });

  const sseBaseUrl = deps.config.sse.baseUrl;
  const streamUrl =
    input.stream && input.background
      ? `${sseBaseUrl}/tasks/${task.id}/stream`
      : undefined;

  // Dependency gating (backlog ac115447): a task with unmet upstreams must not
  // run. `TaskStore.create` already parked it in `waiting`; a background task is
  // left there for `DagEngine.dispatchReady` (called by each task's `runTask`
  // finally after an upstream completes), while a synchronous task rejects
  // rather than bypassing the DAG. Note: a `waiting` task's user message is NOT
  // appended here — `enqueueExistingTask` appends it at real dispatch time, so
  // waiting first does not duplicate it.
  const unmet = unmetDependencies(dependsOn, deps.taskStore);
  if (unmet.length > 0) {
    if (input.background) {
      deps.logger.info(
        { taskId: task.id, dependsOn, unmet },
        'Task has unmet dependencies — waiting for DagEngine dispatch'
      );
      const response: TaskToolOutput = { task_id: task.id, status: 'waiting' };
      if (streamUrl) response.stream_url = streamUrl;
      return response;
    }
    throw new ToolError(
      'VALIDATION_ERROR',
      `Task depends on upstream task(s) that are not yet complete: ${unmet.join(', ')}. ` +
        'Use background:true to let the DAG engine dispatch it when its dependencies complete.',
      { depends_on: dependsOn, unmet }
    );
  }

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
    // Carry the effective cwd so a further sub-dispatch inherits it (ADR-0008 D4).
    cwd: effectiveCwd,
    selection,
    wireModel,
  };

  const controller = new AbortController();
  deps.taskStore.registerCancellation(task.id, controller);

  const provider = buildProviderForSelection({
    agentDefinition,
    selection,
    config: deps.config,
    logger: deps.logger,
    registry: deps.providerRegistry,
    hooks: deps.hooks,
    executionContext,
  });

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
    executionContext,
    deps.config,
    deps.logger
  );

  // A `background:false` session task is SYNCHRONOUS — `taskTool` awaits
  // `orchestrator.run` to completion, so its caller can never receive a
  // resumeToken and no approver is reachable: it must fail closed on an `ask`
  // rather than suspend (ADR-0008 D6). A `background:true` task is enqueued and
  // observable/resumable, so suspension stays answerable.
  const suspensionAnswerable = input.background === true;

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
        suspensionAnswerable,
        emitTaskEvent: deps.emitTaskEvent,
        logger: deps.logger,
        config: deps.config,
      });
    } finally {
      await deps.dagEngine.dispatchReady(task.id);
    }
  };

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

/**
 * Reconstruct a re-dispatched task's delegation attribution from its persisted
 * ancestry (0d77376f). The `tasks` table carries `parent_task_id` only — no
 * `root_task_id` — so the root is recovered by walking `parentTaskId` upward.
 * The result mirrors what `taskTool` stamps on a freshly started child:
 * `rootTaskId` is the topmost ancestor (undefined for a top-level task, never
 * the task's own id), and `callingAgentName` is the IMMEDIATE parent's agent.
 *
 * Bounded: the walk takes at most `recursionDepth + 1` hops and tracks visited
 * ids, so a corrupt/cyclic parent chain terminates instead of hanging. A parent
 * row (or session) that cannot be read leaves the affected field undefined —
 * attribution is best-effort and must never block a re-dispatch.
 */
function reconstructDelegationAttribution(
  task: { parentTaskId?: string; recursionDepth: number },
  deps: TaskDeps
): { rootTaskId?: string; callingAgentName?: string } {
  if (!task.parentTaskId) return {};

  let callingAgentName: string | undefined;
  try {
    const parent = deps.taskStore.read(task.parentTaskId);
    if (parent.sessionId) {
      callingAgentName = deps.sessionStore.getAgentDefinition(parent.sessionId).name;
    }
  } catch (err) {
    deps.logger.warn(
      { parentTaskId: task.parentTaskId, err },
      'enqueueExistingTask: could not resolve the parent agent; callingAgentName left unset'
    );
  }

  const visited = new Set<string>();
  let rootTaskId = task.parentTaskId;
  const maxHops = Math.max(task.recursionDepth, 0) + 1;
  for (let hop = 0; hop < maxHops; hop++) {
    visited.add(rootTaskId);
    let next: string | undefined;
    try {
      next = deps.taskStore.read(rootTaskId).parentTaskId;
    } catch {
      break;
    }
    if (!next || visited.has(next)) break;
    rootTaskId = next;
  }
  return { rootTaskId, callingAgentName };
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

  let resolved: ReturnType<typeof resolveTaskSelection>;
  try {
    resolved = resolveTaskSelection({
      agentDefinition,
      sessionBinding: deps.sessionStore.getSelection?.(task.sessionId) ?? null,
      config: deps.config,
      registry: deps.providerRegistry,
    });
  } catch (err) {
    // Fail closed: a re-dispatched task whose chain resolves no provider is
    // marked failed with the typed reason rather than silently defaulted.
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn({ taskId, err }, 'enqueueExistingTask: no provider selected');
    try {
      deps.taskStore.updateStatus(taskId, 'failed', { error: message });
    } catch {
      // Already terminal — ignore
    }
    return;
  }
  const { selection, wireModel } = resolved;

  const executionContext: ExecutionContext = {
    taskId,
    sessionId: task.sessionId,
    agentName: agentDefinition.name,
    agentDefinition,
    // Preserve the parent/child link across a re-dispatch (restart/DAG): the
    // escalate-to-parent ask chain (ADR-0008 D6) routes an `ask` to this task's
    // parent, so dropping it here would silently disable escalation for any
    // task that was not started inline by `taskTool`.
    parentTaskId: task.parentTaskId,
    recursionDepth: task.recursionDepth,
    // 0d77376f: the `tasks` table has no root column, so root attribution and the
    // calling agent are reconstructed from the persisted parent chain.
    ...reconstructDelegationAttribution(task, deps),
    toolCallCount: 0,
    inputs: task.inputs ?? undefined,
    // 9ed453c1 CWD: restore the persisted dispatching cwd (null for legacy rows).
    cwd: task.cwd ?? undefined,
    selection,
    wireModel,
  };

  const controller = new AbortController();
  deps.taskStore.registerCancellation(taskId, controller);

  const provider = buildProviderForSelection({
    agentDefinition,
    selection,
    config: deps.config,
    logger: deps.logger,
    registry: deps.providerRegistry,
    hooks: deps.hooks,
    executionContext,
  });

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
    executionContext,
    deps.config,
    deps.logger
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

/**
 * A task record after a `fields`/`summary` projection (f2b004eb): `id` is always
 * present, but every other field may have been dropped by the projection and is
 * therefore optional. This is the honest element type of the projected branches
 * of {@link taskList} / {@link resultTool} — typing a partial projection as
 * `Task` (the previous `as unknown as Task[]`) let a caller read a field such as
 * `prompt` as present after projection had removed it.
 */
export type ProjectedTask = Partial<Task> & Pick<Task, 'id'>;

/** A projected `resultTool` payload: the projected task plus the optional usage report. */
export type ProjectedTaskResult = ProjectedTask & { usage?: TaskUsageReport };

/**
 * Project a task-like record onto a caller-requested field set (f2b004eb). `id` is
 * always kept. With `summary`, the two bulk text fields (`prompt`, `result`) are
 * dropped. With neither, the record is returned untouched. Pure — exported for tests.
 */
export function projectTaskRecord<T extends Record<string, unknown>>(
  record: T,
  fields?: readonly string[],
  summary?: boolean
): Record<string, unknown> {
  if (fields && fields.length > 0) {
    const out: Record<string, unknown> = {};
    if ('id' in record) out['id'] = record['id'];
    for (const field of fields) {
      if (field === 'id') continue;
      if (field in record) out[field] = record[field];
    }
    return out;
  }
  if (summary) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'prompt' || key === 'result') continue;
      out[key] = value;
    }
    return out;
  }
  return record;
}

/**
 * List tasks. When `fields` (projection) or `summary` is supplied, each returned
 * element is narrowed to the requested keys — the caller-facing fix for the
 * unbounded prompt/result payload (f2b004eb). Without either, full `Task`s are
 * returned exactly as before.
 *
 * The projected branches return {@link ProjectedTask} (not `Task`), so a caller
 * cannot read a field that projection may have dropped; the unprojected branch
 * returns full `Task`s.
 */
export function taskList(
  input: TaskListInput & { fields: readonly string[] },
  deps: Pick<TaskDeps, 'taskStore'>
): ProjectedTask[];
export function taskList(
  input: TaskListInput & { summary: true },
  deps: Pick<TaskDeps, 'taskStore'>
): ProjectedTask[];
export function taskList(
  input: TaskListInput,
  deps: Pick<TaskDeps, 'taskStore'>
): Task[] | ProjectedTask[];
export function taskList(
  input: TaskListInput,
  deps: Pick<TaskDeps, 'taskStore'>
): Task[] | ProjectedTask[] {
  const tasks = deps.taskStore.list(input);
  if ((input.fields && input.fields.length > 0) || input.summary) {
    return tasks.map(
      (task) =>
        projectTaskRecord(
          task as unknown as Record<string, unknown>,
          input.fields,
          input.summary
        ) as ProjectedTask
    );
  }
  return tasks;
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

/**
 * Fetch a task's result. With `fields`, the returned record is projected to the
 * requested keys (id always kept) and typed as {@link ProjectedTaskResult} — the
 * honest partial type — instead of being cast to a full `Task`. Without
 * `fields`, the full `Task` plus its usage report is returned.
 */
export function resultTool(
  input: ResultInput & { fields: readonly string[] },
  deps: Pick<TaskDeps, 'taskStore' | 'db'>
): ProjectedTaskResult;
export function resultTool(
  input: ResultInput,
  deps: Pick<TaskDeps, 'taskStore' | 'db'>
): (Task | ProjectedTask) & { usage?: TaskUsageReport };
export function resultTool(
  input: ResultInput,
  deps: Pick<TaskDeps, 'taskStore' | 'db'>
): (Task | ProjectedTask) & { usage?: TaskUsageReport } {
  const task = deps.taskStore.read(input.task_id);
  const usage = buildTaskUsageReport(deps.db, task.id);
  const full = { ...task, usage } as Task & { usage?: TaskUsageReport };
  if (input.fields && input.fields.length > 0) {
    return projectTaskRecord(
      full as unknown as Record<string, unknown>,
      input.fields
    ) as ProjectedTaskResult;
  }
  return full;
}

// Import Message for type used above
import type { Message } from '../validation/index.js';
