export type AgentMcpErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_ALREADY_EXISTS'
  | 'AGENT_HAS_ACTIVE_SESSIONS'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_CANCELLABLE'
  | 'TASK_NOT_RESUMABLE'
  | 'DELEGATION_NOT_ALLOWED'
  | 'MAX_DEPTH_EXCEEDED'
  | 'MAX_TOOL_LOOPS_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'MCP_CLIENT_ERROR'
  | 'VALIDATION_ERROR'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_AUTH_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  // Provider-failure taxonomy (docs/plan/provider-failure/SPEC.md §1.2). `failure.class`
  // is the source of truth; these codes are a compatibility projection.
  | 'PROVIDER_BILLING'
  | 'PROVIDER_OVERLOADED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_INVALID_REQUEST'
  | 'PROVIDER_CONTENT_POLICY'
  | 'PROVIDER_PERMISSION'
  | 'BUDGET_EXCEEDED'
  | 'COMPOSED_PROMPT_NOT_FOUND'
  /**
   * The selection chain `task ?? session ?? agent ?? global` resolved no
   * provider type and/or model. Fails closed: there is no implicit default
   * provider (D-G(2)).
   */
  | 'NO_PROVIDER_SELECTED'
  /**
   * The resolved permission map decided `deny` for this tool call (ADR-0008 D5):
   * the tool is NOT executed and the caller receives a typed refusal.
   */
  | 'PERMISSION_DENIED'
  /**
   * An `ask` could not be resolved by the fixed chain — HITL is disabled AND the
   * task has no parent — so it fails closed (ADR-0008 D6). The tool is NOT executed.
   */
  | 'PERMISSION_ASK_DENIED';
