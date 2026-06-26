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
  "TASK_NOT_RESUMABLE",

  // Policy / delegation
  "DELEGATION_NOT_ALLOWED",
  "MAX_DEPTH_EXCEEDED",
  "MAX_TOOL_LOOPS_EXCEEDED",

  // Runtime
  "PROVIDER_ERROR",
  "PROVIDER_TIMEOUT",
  "PROVIDER_AUTH_ERROR",
  "PROVIDER_RATE_LIMITED",
  "CONTEXT_WINDOW_EXCEEDED",
  "MCP_CLIENT_ERROR",

  // Validation
  "VALIDATION_ERROR",

  // Budget enforcement
  "BUDGET_EXCEEDED",

  // Composed-prompt cache
  "COMPOSED_PROMPT_NOT_FOUND",
]);

import type { AgentMcpErrorCode } from "@adhd/agent-mcp-types";
export type { AgentMcpErrorCode };
export type ErrorCode = AgentMcpErrorCode; // alias kept for existing internal usages

export class ToolError extends Error {
  readonly code: AgentMcpErrorCode;
  readonly data?: unknown;

  constructor(code: AgentMcpErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.data = data;
  }
}
