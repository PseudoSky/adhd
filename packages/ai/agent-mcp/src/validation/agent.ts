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
  authTokenEnv: z.string().optional(),
  /** Read OAuth token from the macOS keychain (Claude Code credentials). Auto-refreshes. */
  useClaudeOauth: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

// OpenAI-compatible servers require /vN in the base URL — the SDK appends
// /chat/completions directly, so http://host:1234 → 404 every time.
const versionedBaseUrlSchema = z
  .string()
  .url()
  .refine((url) => /\/v\d+\/?$/.test(url), {
    message: 'baseURL must include the API version path (e.g. "http://localhost:1234/v1")',
  })
  .optional();

const openaiProviderSchema = z.object({
  type: z.literal("openai"),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  baseURL: versionedBaseUrlSchema,
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

const lmstudioProviderSchema = z.object({
  type: z.literal("lmstudio"),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
  baseURL: versionedBaseUrlSchema,
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

const claudecliProviderSchema = z.object({
  type: z.literal("claudecli"),
  /** Model alias or full model string (e.g. "claude-haiku-4-5", "haiku"). Defaults to Claude Code's default. */
  model: z.string().optional(),
  /** Path to the claude binary. Defaults to "claude" (resolved via PATH). */
  claudePath: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Claude Code built-in tool names that are permitted in the subprocess.
   *
   * This is the LEGACY / transition-window allowlist. When ClaudeCliProvider is
   * constructed with a `compiledTools` array derived from the AGENT_TOOL registry
   * model (`compileAgent({ platform: "claude_code" }).tools`), this field is
   * superseded — the compiled tool list is the single source of truth.
   *
   * [inv:no-third-tool-model]: do NOT use this field as a competing third
   * tool-permission model alongside AGENT_TOOL / compiled.tools.
   *
   * All built-ins not in the effective allowed set are passed to --disallowedTools.
   * MCP tools (from mcpServers) are always available regardless of this field.
   * Omit the field (or pass []) to block all built-ins.
   */
  allowedBuiltinTools: z.array(z.string()).optional(),
});

export const providerConfigSchema = z.discriminatedUnion("type", [
  anthropicProviderSchema,
  openaiProviderSchema,
  lmstudioProviderSchema,
  claudecliProviderSchema,
]);

export type { ProviderConfig } from "@adhd/agent-mcp-types";

// Agent permissions
export const agentPermissionsSchema = z.object({
  // If undefined → unrestricted (any agent can be called).
  // If empty array → no agents can be called.
  // If non-empty → only listed agents can be called.
  allowedAgents: z.array(z.string()).optional(),
});

export type { AgentPermissions } from "@adhd/agent-mcp-types";

// Full agent definition (stored)
export const agentDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().positive(),
  provider: providerConfigSchema,
  /**
   * COMPUTED COMPAT SHIM — never user-authored after Plan 6 wave 3 (agent-store-retire).
   *
   * Populated at session start from `compileAgent().content`. The `AgentStore`
   * is now a thin compiled-agent cache; this field holds the resolved system
   * prompt populated from compiler/registry output, not a user-supplied blob.
   */
  systemPrompt: z.optional(z.string()),
  // Full standard MCP server configs embedded in the agent definition.
  // Keys are server names; values are standard McpServerConfig objects.
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  permissions: agentPermissionsSchema.default({}),
  maxToolLoops: z.number().int().positive().optional(),
  /**
   * Opt-in: advertise builtin__request_human_input to the model so it can
   * pause a task and ask the human operator a question. Default false/undefined.
   * Has no effect on ephemeral tasks (no DB row → no resume token).
   */
  allowHumanInput: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type { AgentDefinition } from "@adhd/agent-mcp-types";

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
  // COMPUTED COMPAT SHIM — populated from compiler output, not user-authored.
  systemPrompt: z.optional(z.string()),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  permissions: agentPermissionsSchema.optional(),
  maxToolLoops: z.number().int().positive().optional(),
  allowHumanInput: z.boolean().optional(),
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
  /**
   * When true, close any active sessions for the agent before deleting it.
   * Without this flag, deletion fails with AGENT_HAS_ACTIVE_SESSIONS if any
   * session is still open. Use this as a recovery tool when a failed delegation
   * left orphaned sessions (BUG-002 escape hatch).
   */
  force: z.boolean().optional(),
});

export const agentListInputSchema = z.object({}).optional();

export type AgentCreateInput = z.infer<typeof agentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateInputSchema>;
export type AgentReadInput = z.infer<typeof agentReadInputSchema>;
export type AgentDeleteInput = z.infer<typeof agentDeleteInputSchema>;
