import type { AgentMcpErrorCode } from '@adhd/agent-base-types';

export type ErrorCode = AgentMcpErrorCode;

export class ToolError extends Error {
  readonly code: AgentMcpErrorCode;
  readonly data?: unknown;

  constructor(code: AgentMcpErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.data = data;
  }
}
