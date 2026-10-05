import { z } from 'zod';
import type { ProviderConfig } from '@adhd/agent-base-types';
import { mcpServerConfigSchema } from './mcp.js';
import type { EngineConfig } from '../interfaces.js';

// Retry configuration for LLM provider calls
export const retryConfigSchema = z.object({
  retries: z.number().int().nonnegative().default(3),
  minTimeout: z.number().int().positive().default(1000),
  maxTimeout: z.number().int().positive().default(30_000),
  factor: z.number().positive().default(2),
});

const providerEnvBlockSchema = z
  .object({
    secret: z.string().optional(),
    base_url: z.string().optional(),
    model: z.string().optional(),
  })
  .optional();

const baseUrlSchema = z.string().url().optional();

const anthropicProviderSchema = z.object({
  type: z.literal('anthropic'),
  model: z.string().optional(),
  env: providerEnvBlockSchema,
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

const openaiProviderSchema = z.object({
  type: z.literal('openai'),
  model: z.string().optional(),
  env: providerEnvBlockSchema,
  baseURL: baseUrlSchema,
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryConfig: retryConfigSchema.optional(),
});

const claudecliProviderSchema = z.object({
  type: z.literal('claudecli'),
  model: z.string().optional(),
  claudePath: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  allowedBuiltinTools: z.array(z.string()).optional(),
  systemPromptIsAgentSpec: z.boolean().optional(),
});

// Legacy normalize-on-load shim
function legacyShim(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  let r = { ...(raw as Record<string, unknown>) };

  if (r['type'] === 'lmstudio') {
    r = { ...r, type: 'openai' };
  }

  const apiKeyEnv = r['apiKeyEnv'] as string | undefined;
  const authTokenEnv = r['authTokenEnv'] as string | undefined;
  if (apiKeyEnv || authTokenEnv) {
    const existingEnv =
      typeof r['env'] === 'object' && r['env']
        ? { ...(r['env'] as Record<string, unknown>) }
        : {};
    r = {
      ...r,
      env: {
        ...existingEnv,
        secret: existingEnv['secret'] ?? apiKeyEnv ?? authTokenEnv,
      },
    };
    delete r['apiKeyEnv'];
    delete r['authTokenEnv'];
  }

  delete r['useClaudeOauth'];
  delete r['_useOauthIdentity'];

  return r;
}

export const providerConfigSchema = z.discriminatedUnion('type', [
  anthropicProviderSchema,
  openaiProviderSchema,
  claudecliProviderSchema,
]);

export const providerConfigStoredSchema = z.preprocess(
  legacyShim,
  providerConfigSchema
);

export type { ProviderConfig } from '@adhd/agent-base-types';

export const agentPermissionsSchema = z.object({
  allowedAgents: z.array(z.string()).optional(),
});

export type { AgentPermissions } from '@adhd/agent-base-types';

export const agentDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.number().int().positive(),
  provider: providerConfigSchema,
  systemPrompt: z.optional(z.string()),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
  permissions: agentPermissionsSchema.default({}),
  maxToolLoops: z.number().int().positive().optional(),
  allowHumanInput: z.boolean().optional(),
  sanitization: z.enum(['none', 'prefix', 'wrap']).optional(),
  toolAdvertisement: z.enum(['names', 'full']).optional(),
  nativeWebTools: z.boolean().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type { AgentDefinition } from '@adhd/agent-base-types';

export const agentDefinitionStoredSchema = agentDefinitionSchema.extend({
  provider: providerConfigStoredSchema,
});

/**
 * Build an env-name guard refinement for the given engine config.
 * Returns a superRefine function suitable for use with agent create/update schemas.
 * The `isEnvNameAllowed` predicate is injected via config.
 */
export function buildEnvNameGuard(config: EngineConfig) {
  function envNameGuard(
    provider: ProviderConfig | undefined,
    ctx: z.RefinementCtx,
    providerPath: (string | number)[] = ['provider']
  ): void {
    if (!provider || !('env' in provider) || !provider.env) return;
    for (const [field, name] of Object.entries(provider.env)) {
      if (!name) continue;
      if (!config.isEnvNameAllowed(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...providerPath, 'env', field],
          message:
            `env.${field}: "${name}" is not an allowed env-var name. ` +
            `Only ADHD_AGENT_-prefixed names are permitted by default ` +
            `(add to ADHD_AGENT_ENV_ALLOWLIST to opt in).`,
        });
      }
    }
  }
  return { envNameGuard };
}

/**
 * Validate a parsed agent_create / agent_update payload's provider env-var names against
 * the config's allowlist, throwing a ZodError on the first violation — the create-time
 * guard the published 2.0.1 server applies via `.superRefine`.
 *
 * The static input schemas can't carry this refinement because the allowlist predicate
 * lives on `config` (not available at module scope after the engine refactor). Call this
 * immediately after `.parse()` at each tool call site. See BUG-ORCH-011.
 */
export function assertEnvNamesAllowed(
  provider: ProviderConfig | undefined,
  config: EngineConfig,
  providerPath: (string | number)[] = ['provider']
): void {
  const { envNameGuard } = buildEnvNameGuard(config);
  const issues: z.ZodIssue[] = [];
  const ctx = {
    addIssue: (issue: z.ZodIssue) => issues.push(issue),
    path: [],
  } as unknown as z.RefinementCtx;
  envNameGuard(provider, ctx, providerPath);
  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }
}

export const agentCreateInputSchema = agentDefinitionSchema
  .omit({
    version: true,
    createdAt: true,
    updatedAt: true,
  });

/**
 * One key's value in an `mcpServers` patch: a full server config to upsert
 * (create or replace that key), or `null` to DELETE the key. The explicit
 * `null` is what makes a rename expressible — a plain record-merge can only
 * add/overwrite keys, so a renamed key would leave the old one permanently
 * stranded (BUG: agent_update cannot remove/rename an mcpServers key).
 */
export const mcpServerPatchValueSchema = mcpServerConfigSchema.nullable();

/** The `mcpServers` half of an `agent_update` patch — see
 *  {@link mcpServerPatchValueSchema} for the upsert-vs-delete semantics. */
export const mcpServersPatchSchema = z.record(
  z.string(),
  mcpServerPatchValueSchema
);

export type McpServerPatchValue = z.infer<typeof mcpServerPatchValueSchema>;
export type McpServersPatch = z.infer<typeof mcpServersPatchSchema>;

export const agentPatchSchema = z.object({
  description: z.string().optional(),
  provider: providerConfigSchema.optional(),
  systemPrompt: z.optional(z.string()),
  mcpServers: mcpServersPatchSchema.optional(),
  permissions: agentPermissionsSchema.optional(),
  maxToolLoops: z.number().int().positive().optional(),
  allowHumanInput: z.boolean().optional(),
  sanitization: z.enum(['none', 'prefix', 'wrap']).optional(),
  nativeWebTools: z.boolean().optional(),
});

/**
 * The closed vocabulary of agent-definition fields a caller may project onto
 * via `fields[]`. Declaring it as an enum makes an unknown key a validation
 * error, never a silent drop. `systemPrompt` is intentionally in the list:
 * it is the one field that requires an explicit opt-in, so a caller who wants
 * it must name it (this is what keeps the multi-KB prompt body out of every
 * default MCP response).
 */
export const AGENT_PROJECTABLE_FIELDS = [
  'name',
  'description',
  'version',
  'provider',
  'systemPrompt',
  'mcpServers',
  'permissions',
  'maxToolLoops',
  'allowHumanInput',
  'sanitization',
  'toolAdvertisement',
  'nativeWebTools',
  'createdAt',
  'updatedAt',
] as const;

export type AgentProjectableField = (typeof AGENT_PROJECTABLE_FIELDS)[number];

/**
 * The opt-in projection controls shared by `agent_read` / `agent_list` (and
 * accepted by `agent_update`'s response). With neither supplied, the response
 * is a bounded summary that OMITS `systemPrompt` — the multi-KB body that must
 * never be dumped unrequested.
 *
 * The full-record opt-in is deliberately named `fullDefinition`, not `full`:
 * the name itself states that it returns the FULL agent definition including
 * `systemPrompt`, so a caller cannot enable a multi-KB payload by accident
 * with an ambiguous flag. `fields` is the complementary, equally explicit
 * whitelist (`fields: ['systemPrompt']` names the body directly).
 */
export const agentProjectionFields = {
  fullDefinition: z
    .boolean()
    .optional()
    .describe(
      'Return the FULL agent definition including the systemPrompt body. Defaults to false: by default the response is a summary that omits systemPrompt.'
    ),
  fields: z
    .array(z.enum(AGENT_PROJECTABLE_FIELDS))
    .optional()
    .describe(
      "Project each record onto these fields (name is always included). Pass ['systemPrompt'] to opt into the prompt body; leaving it out omits the body."
    ),
};

export const agentUpdateInputSchema = z.object({
  name: z.string().min(1),
  patch: agentPatchSchema,
  ...agentProjectionFields,
});

export const agentReadInputSchema = z.object({
  name: z.string().min(1),
  ...agentProjectionFields,
});

export const agentDeleteInputSchema = z.object({
  name: z.string().min(1),
  force: z.boolean().optional(),
});

export const agentListInputSchema = z.object({
  ...agentProjectionFields,
});

export type AgentCreateInput = z.infer<typeof agentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateInputSchema>;
export type AgentReadInput = z.infer<typeof agentReadInputSchema>;
export type AgentDeleteInput = z.infer<typeof agentDeleteInputSchema>;
export type AgentListInput = z.infer<typeof agentListInputSchema>;
