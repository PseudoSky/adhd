import { z } from "zod";
import { agentDefinitionSchema } from "./agent.js";

// ExecutionContext is constructed at runtime and threaded through the
// orchestrator. It is never persisted directly.
export const executionContextSchema = z.object({
  taskId: z.string().uuid(),
  sessionId: z.string().uuid(),

  // The agent currently executing this task.
  agentName: z.string(),

  // The full snapshotted AgentDefinition for the executing agent.
  // This is what PolicyEngine uses as `callingAgent` for allowedAgents checks.
  agentDefinition: agentDefinitionSchema,

  // The agent that spawned this task (undefined for top-level tasks).
  // Used for logging only — never for policy decisions.
  callingAgentName: z.string().optional(),

  parentTaskId: z.string().uuid().optional(),

  // Starts at 0 for every task. Incremented by the orchestrator after
  // each tool call result is appended. PolicyEngine reads this value
  // to enforce the toolLoops ceiling.
  recursionDepth: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),

  // Upstream task results keyed by upstream taskId.
  // Populated by DagEngine at dispatch time from the task row's `inputs` JSON field.
  // Only present for tasks that have depends_on entries; omit from runtime context
  // if not set on the task row.
  inputs: z.record(z.string(), z.string()).optional(),
});

export type { ExecutionContext } from "@adhd/agent-mcp-types";
