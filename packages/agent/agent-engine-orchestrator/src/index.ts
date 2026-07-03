// barrel exports for @adhd/agent-engine-orchestrator

// ── Interfaces ────────────────────────────────────────────────────────────────
export type { EngineConfig, EngineLogger } from './interfaces.js';

// ── Engine ────────────────────────────────────────────────────────────────────
export { Orchestrator } from './engine/orchestrator.js';
export type { OrchestratorRunInput, OrchestratorRunResult, OrchestratorTaskStore, OrchestratorSessionStore } from './engine/orchestrator.js';
export { resolveHitl } from './engine/orchestrator.js';
export { PolicyEngine } from './engine/policy.js';
export type { PolicyConfig, PolicyCheckInput, AgentPolicyTemplateRule } from './engine/policy.js';
export { HookRegistry } from './engine/hooks.js';
export { BackgroundQueue } from './engine/queue.js';
export type { BackgroundTaskFn } from './engine/queue.js';
export { DagEngine } from './engine/dag-engine.js';
export type { DagTaskStore, DagQueue } from './engine/dag-engine.js';
export { resolveComposedPrompt, computeContextHash } from './engine/prompt-resolver.js';
export type { ResolveInput, ResolveResult, CompileAgentFn, PromptResolverDeps } from './engine/prompt-resolver.js';
export { renderToolPromptDoc, toNameOnlyTools } from './engine/tool-advertisement.js';
export type { ToolAdvertisementMode } from './engine/tool-advertisement.js';

// ── Providers ─────────────────────────────────────────────────────────────────
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';
export { ClaudeCliProvider, computeClaudeBuiltinArgs, extractAgentSpecName, normalizeAgentSpec } from './providers/claudecli.js';
export { createProvider } from './providers/factory.js';
export type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from './providers/types.js';
export type { ToolDefinition, TokenUsage } from '@adhd/agent-base-types';

// ── Clients ───────────────────────────────────────────────────────────────────
export { McpClientRegistry } from './clients/registry.js';
export { InProcessMcpClient } from './clients/in-process.js';
export type { InProcessToolHandler, InProcessToolDescriptor } from './clients/in-process.js';
export { StdioMcpClient } from './clients/stdio-client.js';
export { HttpMcpClient, SseMcpClient } from './clients/http-client.js';
export { TOOL_NAME_SEPARATOR, normalizeToolName, resolveToolCallName } from './clients/tool-naming.js';
export type { ResolvedToolName } from './clients/tool-naming.js';
export type { IMcpClient } from './clients/types.js';

// ── Tools ─────────────────────────────────────────────────────────────────────
export { agentCreate, agentRead, agentUpdate, agentDelete, agentList } from './tools/agent-crud.js';
export type { AgentCrudDeps } from './tools/agent-crud.js';
export type { AgentStore } from './tools/agent-crud.js';
export { agentTool, sessionList, sessionClose, sessionClear } from './tools/session.js';
export type { SessionDeps } from './tools/session.js';
export { taskTool, taskList, taskCancel, taskResume, resultTool, enqueueExistingTask } from './tools/task.js';
export type { TaskDeps } from './tools/task.js';
export { usageQuery, buildTaskUsageReport } from './tools/usage.js';
export type { Database, UsageQueryResult, TaskUsageRow } from './tools/usage.js';

// ── Plugins ───────────────────────────────────────────────────────────────────
export { UsagePlugin } from './plugins/usage-plugin.js';
export { loadExternalPlugins, findConfigFile, loadConfigFile, agentMcpConfigFileSchema } from './plugins/loader.js';
export type { AgentMcpConfigFile, PluginEntry } from './plugins/loader.js';

// ── Validation ────────────────────────────────────────────────────────────────
export * from './validation/mcp.js';
export * from './validation/agent.js';
export * from './validation/session.js';
export * from './validation/message.js';
export * from './validation/task.js';
export * from './validation/usage.js';
export * from './validation/execution.js';
export * from './validation/errors.js';
