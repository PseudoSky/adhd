import { z } from "zod";
import type { ProviderConfig } from "@adhd/agent-mcp-types";
import { mcpServerConfigSchema } from "./mcp.js";
import { config } from "../config.js";

// Retry configuration for LLM provider calls
export const retryConfigSchema = z.object({
  retries: z.number().int().nonnegative().default(3),
  minTimeout: z.number().int().positive().default(1000),
  maxTimeout: z.number().int().positive().default(30_000),
  factor: z.number().positive().default(2),
});

// ── Provider env block (§3) ───────────────────────────────────────────────────
// Each field holds an ADHD_AGENT_*-prefixed env-var NAME (not the secret value).
// Enforced at agent_create / agent_update time by the isEnvNameAllowed guard.

const providerEnvBlockSchema = z
    .object({
        /** Env-var name whose value is the secret (API key or OAuth token). */
        secret:   z.string().optional(),
        /** Env-var name whose value is the provider base URL. */
        base_url: z.string().optional(),
        /** Env-var name whose value is the model id. */
        model:    z.string().optional(),
    })
    .optional();
// NOTE (DEBT-014): the ADHD_AGENT_-prefix guard is intentionally NOT applied on this
// base block. It runs ONLY on agent_create / agent_update INPUT (see envNameGuard
// below) — never on the READ path, or legacy stored rows whose secret name predates
// the prefix scheme would fail to parse (and even agent_delete, which reads the row,
// would break).

// ── Base-URL schema (§3) ──────────────────────────────────────────────────────
// Transform-free so the schema is representable in JSON Schema (z.toJSONSchema is
// used to build every MCP tool inputSchema — a `.transform()` here makes tools/list
// throw "Transforms cannot be represented in JSON Schema"). The /v1 normalisation
// (no path → append /v1; explicit path respected) is applied at RUNTIME in
// config.getProviderConfig → normalizeBaseUrl, for both inline and env-sourced URLs.
const baseUrlSchema = z.string().url().optional();

// ── Provider config schemas ───────────────────────────────────────────────────

const anthropicProviderSchema = z.object({
    type:        z.literal("anthropic"),
    model:       z.string().optional(),
    env:         providerEnvBlockSchema,
    temperature: z.number().min(0).max(1).optional(),
    maxTokens:   z.number().int().positive().optional(),
    timeoutMs:   z.number().int().positive().optional(),
    retryConfig: retryConfigSchema.optional(),
});

const openaiProviderSchema = z.object({
    type:        z.literal("openai"),
    model:       z.string().optional(),
    env:         providerEnvBlockSchema,
    /** Inline literal base URL — /v1-normalised at runtime in getProviderConfig. */
    baseURL:     baseUrlSchema,
    temperature: z.number().min(0).max(1).optional(),
    maxTokens:   z.number().int().positive().optional(),
    timeoutMs:   z.number().int().positive().optional(),
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
     * Ignored when `systemPromptIsAgentSpec` is true.
     */
    allowedBuiltinTools: z.array(z.string()).optional(),
    /**
     * When true, treat `systemPrompt` as a Claude Code agent markdown file
     * (frontmatter + body) and let Claude internally parse its `tools:` header,
     * which then takes precedence over the built-in --disallowedTools enumeration.
     */
    systemPromptIsAgentSpec: z.boolean().optional(),
});

// ── Legacy normalize-on-load shim (§9.1) ─────────────────────────────────────
// Stored rows that pre-date this change may contain:
//   • type: "lmstudio"        → coerce to type: "openai"
//   • apiKeyEnv / authTokenEnv → map to env.secret
//   • useClaudeOauth           → drop (keychain path removed §3b)
// This runs transparently on every schema.parse() call so the real
// ~/.adhd/agent-mcp/agents.db keeps parsing without a migration.

function legacyShim(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    let r = { ...(raw as Record<string, unknown>) };

    // lmstudio → openai (lmstudio is just an OpenAI-compatible local server)
    if (r["type"] === "lmstudio") {
        r = { ...r, type: "openai" };
    }

    // apiKeyEnv / authTokenEnv → env.secret (unified credential field)
    const apiKeyEnv   = r["apiKeyEnv"]   as string | undefined;
    const authTokenEnv = r["authTokenEnv"] as string | undefined;
    if (apiKeyEnv || authTokenEnv) {
        const existingEnv =
            typeof r["env"] === "object" && r["env"]
                ? { ...(r["env"] as Record<string, unknown>) }
                : {};
        r = {
            ...r,
            env: {
                ...existingEnv,
                // keep explicit env.secret if already present
                secret: existingEnv["secret"] ?? apiKeyEnv ?? authTokenEnv,
            },
        };
        delete r["apiKeyEnv"];
        delete r["authTokenEnv"];
    }

    // useClaudeOauth → removed in §3b (keychain subsystem deleted)
    delete r["useClaudeOauth"];
    // _useOauthIdentity was internal state, not stored — drop if present
    delete r["_useOauthIdentity"];

    return r;
}

// Transform-free discriminated union — safe for z.toJSONSchema (MCP tool inputSchema).
export const providerConfigSchema = z.discriminatedUnion("type", [
    anthropicProviderSchema,
    openaiProviderSchema,
    claudecliProviderSchema,
]);

// Stored-row variant: applies the legacy normalize-on-load shim (§9.1) BEFORE
// validation so pre-change agents.db rows keep parsing. Used ONLY on the READ path
// (agent-store / session snapshot). NEVER pass this to z.toJSONSchema — z.preprocess
// is a transform and would break MCP tools/list.
export const providerConfigStoredSchema = z.preprocess(legacyShim, providerConfigSchema);

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

// Stored-row variant of the agent definition — applies the legacy provider shim on
// read (via providerConfigStoredSchema). Used by agent-store / session-store when
// parsing persisted rows; NEVER fed to z.toJSONSchema. New-shape writes validate
// against agentDefinitionSchema (and the transform-free agentCreateInputSchema).
export const agentDefinitionStoredSchema = agentDefinitionSchema.extend({
    provider: providerConfigStoredSchema,
});

// --- Tool input/output schemas ---

// ── Env-name guard (INPUT-only, §6 / DEBT-014) ────────────────────────────────
// Stops a caller from pointing an agent at an arbitrary host secret at create/update
// time. Applied via .superRefine on the input schemas ONLY (refinements are
// representable in JSON Schema, unlike transforms). Never on the read path.
function envNameGuard(provider: ProviderConfig | undefined, ctx: z.RefinementCtx): void {
    // `env` exists only on the openai/anthropic members of the union (not claudecli).
    if (!provider || !("env" in provider) || !provider.env) return;
    for (const [field, name] of Object.entries(provider.env)) {
        if (!name) continue;
        if (!config.isEnvNameAllowed(name)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["provider", "env", field],
                message:
                    `env.${field}: "${name}" is not an allowed env-var name. ` +
                    `Only ADHD_AGENT_-prefixed names are permitted by default ` +
                    `(add to ADHD_AGENT_ENV_ALLOWLIST to opt in).`,
            });
        }
    }
}

export const agentCreateInputSchema = agentDefinitionSchema
    .omit({
        version: true,
        createdAt: true,
        updatedAt: true,
    })
    .superRefine((val, ctx) => envNameGuard(val.provider, ctx));

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

export const agentUpdateInputSchema = z
    .object({
        name: z.string().min(1),
        patch: agentPatchSchema,
    })
    .superRefine((val, ctx) => envNameGuard(val.patch.provider, ctx));

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
