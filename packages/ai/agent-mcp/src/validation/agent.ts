import { z } from "zod";
import { mcpServerConfigSchema } from "./mcp.js";

// Retry configuration for LLM provider calls
export const retryConfigSchema = z.object({
  retries: z.number().int().nonnegative().default(3),
  minTimeout: z.number().int().positive().default(1000),
  maxTimeout: z.number().int().positive().default(30_000),
  factor: z.number().positive().default(2),
});

// Provider config — discriminated union on "type"
const anthropicProviderSchema = z.object({
  type: z.literal("anthropic"),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

const openaiProviderSchema = z.object({
  type: z.literal("openai"),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().url().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

const lmstudioProviderSchema = z.object({
  type: z.literal("lmstudio"),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().url().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

export const providerConfigSchema = z.discriminatedUnion("type", [
  anthropicProviderSchema,
  openaiProviderSchema,
  lmstudioProviderSchema,
]);

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

// Agent permissions
export const agentPermissionsSchema = z.object({
  // If undefined → unrestricted (any agent can be called).
  // If empty array → no agents can be called.
  // If non-empty → only listed agents can be called.
  allowedAgents: z.array(z.string()).optional(),
});

export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;

// Full agent definition (stored)
export const agentDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().positive(),
  provider: providerConfigSchema,
  systemPrompt: z.string(),
  // Full standard MCP server configs embedded in the agent definition.
  // Keys are server names; values are standard McpServerConfig objects.
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  permissions: agentPermissionsSchema.default({}),
  maxToolLoops: z.number().int().positive().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

// --- Tool input/output schemas ---

export const agentCreateInputSchema = agentDefinitionSchema.omit({
  version: true,
  createdAt: true,
  updatedAt: true,
});

// Patch schema for agent_update — intentionally no .default() on any field
// so that absent fields stay undefined and don't overwrite stored values.
const agentPatchSchema = z.object({
  description: z.string().optional(),
  provider: providerConfigSchema.optional(),
  systemPrompt: z.string().optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  permissions: agentPermissionsSchema.optional(),
  maxToolLoops: z.number().int().positive().optional(),
});

export const agentUpdateInputSchema = z.object({
  name: z.string().min(1),
  patch: agentPatchSchema,
});

export const agentReadInputSchema = z.object({
  name: z.string().min(1),
});

export const agentDeleteInputSchema = z.object({
  name: z.string().min(1),
});

export const agentListInputSchema = z.object({}).optional();

export type AgentCreateInput = z.infer<typeof agentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateInputSchema>;
export type AgentReadInput = z.infer<typeof agentReadInputSchema>;
export type AgentDeleteInput = z.infer<typeof agentDeleteInputSchema>;
