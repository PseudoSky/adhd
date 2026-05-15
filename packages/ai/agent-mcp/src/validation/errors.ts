import { z } from "zod";

export const errorCodeSchema = z.enum([
  // Agent CRUD
  "AGENT_ALREADY_EXISTS",
  "AGENT_NOT_FOUND",
  "AGENT_HAS_ACTIVE_SESSIONS",

  // Session
  "SESSION_NOT_FOUND",
  "SESSION_CLOSED",

  // Task
  "TASK_NOT_FOUND",
  "TASK_NOT_CANCELLABLE",

  // Policy / delegation
  "DELEGATION_NOT_ALLOWED",
  "MAX_DEPTH_EXCEEDED",
  "MAX_TOOL_LOOPS_EXCEEDED",

  // Runtime
  "PROVIDER_ERROR",
  "MCP_CLIENT_ERROR",

  // Validation
  "VALIDATION_ERROR",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.data = data;
  }
}
