import { logger } from "../logger.js";
import type { BackgroundQueue } from "../engine/queue.js";
import type { Orchestrator } from "../engine/orchestrator.js";
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
} from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { IHookRegistry } from "@adhd/agent-mcp-types";

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

    return {
        task_id: taskId,
        status: capturedStatus,
        result: capturedResult,
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
    const task = deps.taskStore.create({
        sessionId: input.session_id,
        prompt: input.prompt,
        parentTaskId: callerContext?.taskId,
        recursionDepth: (callerContext?.recursionDepth ?? -1) + 1,
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
    };

    if (input.background) {
        // Enqueue for background execution — return immediately
        deps.queue.enqueue(task.id, runTask);

        logger.info(
            { taskId: task.id, sessionId: input.session_id },
            "Task enqueued for background execution"
        );

        return {
            task_id: task.id,
            status: "pending",
        };
    } else {
        // Synchronous execution — wait for completion
        try {
            await runTask();
        } catch (error) {
            // Orchestrator already updated the task status
            // Return the current task state
        }

        const finalTask = deps.taskStore.read(task.id);
        return {
            task_id: finalTask.id,
            status: finalTask.status,
            result: finalTask.result,
        };
    }
}

export function taskList(input: TaskListInput, deps: Pick<TaskDeps, "taskStore">): Task[] {
    return deps.taskStore.list(input);
}

export function taskCancel(input: TaskCancelInput, deps: Pick<TaskDeps, "taskStore">): { success: true } {
    const task = deps.taskStore.read(input.task_id); // throws TASK_NOT_FOUND

    const cancellableStatuses = ["pending", "running"] as const;
    if (!cancellableStatuses.includes(task.status as typeof cancellableStatuses[number])) {
        throw new ToolError(
            "TASK_NOT_CANCELLABLE",
            `Task '${input.task_id}' has status '${task.status}' and cannot be cancelled`
        );
    }

    deps.taskStore.cancel(input.task_id);
    return { success: true };
}

export function resultTool(input: ResultInput, deps: Pick<TaskDeps, "taskStore">): Task {
    return deps.taskStore.read(input.task_id); // throws TASK_NOT_FOUND
}
