import { logger } from "../logger.js";
import type { BackgroundQueue } from "../engine/queue.js";
import type { DagEngine } from "../engine/dag-engine.js";
import type { Orchestrator } from "../engine/orchestrator.js";
import { resolveHitl } from "../engine/orchestrator.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { InProcessToolDescriptor, InProcessToolHandler } from "../clients/in-process.js";
import { createProvider } from "../providers/factory.js";
import type { AgentStore } from "../store/agent-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { TaskStore } from "../store/task-store.js";
import { McpClientRegistry as McpClientRegistryCtor } from "../clients/registry.js";
import type {
    ExecutionContext,
    ResultInput,
    Task,
    TaskCancelInput,
    TaskListInput,
    TaskStatus,
    TaskToolInput,
    TaskToolOutput,
    TaskUsageReport,
} from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";
import { buildTaskUsageReport, type Database } from "./usage.js";

export interface TaskDeps {
    agentStore: AgentStore;
    sessionStore: SessionStore;
    taskStore: TaskStore;
    orchestrator: Orchestrator;
    queue: BackgroundQueue;
    policy: PolicyEngine;
    hooks: IHookRegistry;
    selfUrl: string | undefined;
    inProcessDescriptors: InProcessToolDescriptor[];
    inProcessHandler: InProcessToolHandler;
    /**
     * Drizzle DB handle — used to enrich `task` / `result` responses with the
     * task's token-usage rollup (direct + subtree). See [dod.2].
     */
    db: Database;
    /**
     * DagEngine — manages dependency cycle detection and fan-in dispatch.
     * Injected at server startup (index.ts) to avoid circular imports.
     */
    dagEngine: DagEngine;
}

/**
 * One-shot ephemeral execution: loads the agent definition but creates no session
 * row and persists no messages. Always synchronous.
 */
async function runEphemeralTask(
    input: { agent_name: string; prompt: string },
    deps: TaskDeps,
    callerContext?: ExecutionContext
): Promise<TaskToolOutput> {
    const agentDefinition = deps.agentStore.read(input.agent_name);

    const taskId = generateId();
    const ephemeralSessionId = generateId();
    const rootTaskId = callerContext
        ? (callerContext.rootTaskId ?? callerContext.taskId)
        : undefined;

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

    const provider = createProvider(agentDefinition.provider, agentDefinition.mcpServers);

    const userMessage = {
        id: generateId(),
        sessionId: ephemeralSessionId,
        role: "user" as const,
        content: input.prompt,
        createdAt: nowIso(),
    };
    const messages = agentDefinition.systemPrompt
        ? [
              {
                  id: generateId(),
                  sessionId: ephemeralSessionId,
                  role: "system" as const,
                  content: agentDefinition.systemPrompt,
                  createdAt: nowIso(),
              },
              userMessage,
          ]
        : [userMessage];

    // Capture final status/result without touching the DB
    let capturedStatus: TaskStatus = "pending";
    let capturedResult: string | undefined;

    const captureTaskStore = {
        updateStatus: (_id: string, status: TaskStatus, fields?: { result?: string }) => {
            capturedStatus = status;
            if (fields?.result !== undefined) capturedResult = fields.result;
            return {} as Task;
        },
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        appendEvent: () => {},
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        unregisterCancellation: () => {},
    } as unknown as TaskStore;

    const noopSessionStore = {
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        appendMessage: async () => {},
    } as unknown as SessionStore;

    const registry = new McpClientRegistryCtor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentDefinition.mcpServers as any,
        deps.selfUrl,
        deps.inProcessDescriptors,
        deps.inProcessHandler,
        executionContext
    );

    const controller = new AbortController();

    try {
        await deps.orchestrator.run({
            executionContext,
            messages,
            registry,
            provider,
            policy: deps.policy,
            taskStore: captureTaskStore,
            sessionStore: noopSessionStore,
            signal: controller.signal,
            taskId,
            hooks: deps.hooks,
        });
    } catch {
        // Orchestrator already captured status via captureTaskStore
    }

    const usage = buildTaskUsageReport(deps.db, taskId);

    return {
        task_id: taskId,
        status: capturedStatus,
        result: capturedResult,
        usage,
    };
}

/**
 * `task` tool — runs a prompt against a session's agent (session mode) or runs a
 * one-shot ephemeral task without persisting any context (agent_name mode).
 *
 * Session mode mandatory order (per plan Gap 17):
 *  1. Validate session exists and is active
 *  2. Load snapshotted AgentDefinition
 *  3. Create Task row
 *  4. Build ExecutionContext
 *  5. Create AbortController
 *  6. Register cancellation
 *  7. Build provider
 *  8. Build per-task registry
 *  9. Run orchestrator (background or sync)
 */
export async function taskTool(
    input: TaskToolInput,
    deps: TaskDeps,
    callerContext?: ExecutionContext
): Promise<TaskToolOutput> {
    if ("agent_name" in input) {
        return runEphemeralTask(input, deps, callerContext);
    }

    // 1. Validate session
    const session = deps.sessionStore.read(input.session_id);
    if (session.status !== "active") {
        throw new ToolError("SESSION_CLOSED", `Session '${input.session_id}' is closed`);
    }

    // 2. Load snapshotted agent definition
    const agentDefinition = deps.sessionStore.getAgentDefinition(input.session_id);

    // 3. Create task row
    // Validate no dependency cycle before inserting the row.
    // [inv:cycle-check-synchronous] — throws ToolError("VALIDATION_ERROR") on cycle.
    const dependsOn = (input as { depends_on?: string[] }).depends_on ?? [];
    const prospectiveTaskId = generateId();
    if (dependsOn.length > 0) {
        deps.dagEngine.validateNoCycle(prospectiveTaskId, dependsOn);
    }

    const task = deps.taskStore.create({
        sessionId: input.session_id,
        prompt: input.prompt,
        parentTaskId: callerContext?.taskId,
        recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    });

    // Derive rootTaskId at creation time from the in-memory callerContext chain.
    // A DB walk is deliberately avoided — ephemeral tasks have no tasks row.
    const rootTaskId = callerContext
        ? (callerContext.rootTaskId ?? callerContext.taskId)
        : undefined;

    // 4. Build execution context
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

    // 5. Create AbortController
    const controller = new AbortController();

    // 6. Register cancellation
    deps.taskStore.registerCancellation(task.id, controller);

    // 7. Build provider
    const provider = createProvider(agentDefinition.provider, agentDefinition.mcpServers);

    // Build initial messages
    const existingMessages = deps.sessionStore.getMessages(input.session_id);
    const userMessage = {
        id: generateId(),
        sessionId: input.session_id,
        role: "user" as const,
        content: input.prompt,
        createdAt: nowIso(),
    };
    await deps.sessionStore.appendMessage(input.session_id, userMessage);
    const messages = [...existingMessages, userMessage];

    // Add system message if the agent has one
    const allMessages = agentDefinition.systemPrompt
        ? [
              {
                  id: generateId(),
                  sessionId: input.session_id,
                  role: "system" as const,
                  content: agentDefinition.systemPrompt,
                  createdAt: nowIso(),
              },
              ...messages,
          ]
        : messages;

    // 8. Build per-task registry
    const registry = new McpClientRegistryCtor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentDefinition.mcpServers as any,
        deps.selfUrl,
        deps.inProcessDescriptors,
        deps.inProcessHandler,
        executionContext
    );

    // 9. Run orchestrator
    const runTask = async (): Promise<void> => {
        try {
            await deps.orchestrator.run({
                executionContext,
                messages: allMessages,
                registry,
                provider,
                policy: deps.policy,
                taskStore: deps.taskStore,
                sessionStore: deps.sessionStore,
                signal: controller.signal,
                taskId: task.id,
                hooks: deps.hooks,
            });
        } finally {
            // [inv:dispatch-on-completion] — dispatchReady fires on every terminal
            // event (completed, failed, cancelled) so dependent waiting tasks are
            // evaluated regardless of how this task ended.
            await deps.dagEngine.dispatchReady(task.id);
        }
    };

    // Compute stream_url when input.stream is true
    const ssePort = process.env["SSE_PORT"] ?? "3001";
    const sseBaseUrl = process.env["SSE_BASE_URL"] ?? `http://localhost:${ssePort}`;
    const streamUrl = input.stream ? `${sseBaseUrl}/tasks/${task.id}/stream` : undefined;

    if (input.background) {
        // Enqueue for background execution — return immediately
        deps.queue.enqueue(task.id, runTask);

        logger.info(
            { taskId: task.id, sessionId: input.session_id },
            "Task enqueued for background execution"
        );

        const response: TaskToolOutput = {
            task_id: task.id,
            status: "pending",
        };
        if (streamUrl) {
            response.stream_url = streamUrl;
        }
        return response;
    } else {
        // Synchronous execution — wait for completion
        try {
            await runTask();
        } catch (error) {
            // Orchestrator already updated the task status
            // Return the current task state
        }

        const finalTask = deps.taskStore.read(task.id);
        const usage = buildTaskUsageReport(deps.db, finalTask.id);
        const response: TaskToolOutput = {
            task_id: finalTask.id,
            status: finalTask.status,
            result: finalTask.result,
            usage,
        };
        if (streamUrl) {
            response.stream_url = streamUrl;
        }
        return response;
    }
}

/**
 * Re-enqueue an existing task row that is already in "pending" status.
 *
 * Called by DagEngine.dispatchFn (built in index.ts) when a waiting task
 * transitions to pending after all its dependencies complete. The task row
 * already exists in the DB — this function only builds the runtime context
 * (executionContext, messages, provider, registry) and enqueues it.
 *
 * Also used on server startup to re-enqueue tasks orphaned by a crash between
 * DagEngine's DB update and queue.enqueue().
 */
export async function enqueueExistingTask(taskId: string, deps: TaskDeps): Promise<void> {
    const task = deps.taskStore.read(taskId);
    const session = deps.sessionStore.read(task.sessionId);

    if (session.status !== "active") {
        logger.warn(
            { taskId, sessionId: task.sessionId },
            "enqueueExistingTask: session is not active, skipping dispatch"
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

    const provider = createProvider(agentDefinition.provider, agentDefinition.mcpServers);

    const existingMessages = deps.sessionStore.getMessages(task.sessionId);
    const userMessage = {
        id: generateId(),
        sessionId: task.sessionId,
        role: "user" as const,
        content: task.prompt,
        createdAt: nowIso(),
    };
    const messages = [...existingMessages, userMessage];

    const allMessages = agentDefinition.systemPrompt
        ? [
              {
                  id: generateId(),
                  sessionId: task.sessionId,
                  role: "system" as const,
                  content: agentDefinition.systemPrompt,
                  createdAt: nowIso(),
              },
              ...messages,
          ]
        : messages;

    const registry = new McpClientRegistryCtor(
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
                sessionStore: deps.sessionStore,
                signal: controller.signal,
                taskId,
                hooks: deps.hooks,
            });
        } finally {
            // [inv:dispatch-on-completion] — dispatchReady fires on every terminal event
            await deps.dagEngine.dispatchReady(taskId);
        }
    });
}

export function taskList(input: TaskListInput, deps: Pick<TaskDeps, "taskStore">): Task[] {
    return deps.taskStore.list(input);
}

export function taskCancel(input: TaskCancelInput, deps: Pick<TaskDeps, "taskStore">): { success: true } {
    const task = deps.taskStore.read(input.task_id); // throws TASK_NOT_FOUND

    const cancellableStatuses = ["pending", "running", "awaiting_input"] as const;
    if (!cancellableStatuses.includes(task.status as typeof cancellableStatuses[number])) {
        throw new ToolError(
            "TASK_NOT_CANCELLABLE",
            `Task '${input.task_id}' has status '${task.status}' and cannot be cancelled`
        );
    }

    deps.taskStore.cancel(input.task_id);
    return { success: true };
}

/**
 * `task_resume` tool — resumes a suspended `awaiting_input` task by providing
 * the `userInput` that the orchestrator is waiting for.
 *
 * The caller must supply the `resumeToken` that was written to the DB when the
 * task was suspended. If the process restarted while the task was suspended the
 * in-memory resolver no longer exists; the task is auto-failed and
 * `TASK_NOT_RESUMABLE` is thrown so the caller knows not to retry.
 */
export async function taskResume(
    input: { taskId: string; resumeToken: string; userInput: string },
    deps: Pick<TaskDeps, "taskStore">
): Promise<{ success: true; taskId: string }> {
    const task = deps.taskStore.read(input.taskId); // throws TASK_NOT_FOUND

    if (task.status !== "awaiting_input") {
        throw new ToolError(
            "VALIDATION_ERROR",
            `Task '${input.taskId}' is not awaiting input (status: ${task.status})`
        );
    }

    if (task.resumeToken !== input.resumeToken) {
        throw new ToolError("VALIDATION_ERROR", "Invalid resumeToken");
    }

    const resolved = resolveHitl(input.taskId, input.userInput);
    if (!resolved) {
        // Process restarted — in-memory resolver is gone. Auto-fail the task so it
        // doesn't remain stranded in awaiting_input with no escape path.
        deps.taskStore.updateStatus(input.taskId, "failed", {
            error: "Task could not be resumed: server restarted while task was suspended. Create a new task.",
        });
        throw new ToolError(
            "TASK_NOT_RESUMABLE",
            `Task '${input.taskId}' has no active suspension (process restarted; task has been failed)`
        );
    }

    return { success: true, taskId: input.taskId };
}

export function resultTool(
    input: ResultInput,
    deps: Pick<TaskDeps, "taskStore" | "db">
): Task & { usage?: TaskUsageReport } {
    const task = deps.taskStore.read(input.task_id); // throws TASK_NOT_FOUND
    const usage = buildTaskUsageReport(deps.db, task.id);
    return { ...task, usage };
}
