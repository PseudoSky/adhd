import { z } from 'zod';
import { mcpServerConfigSchema } from './mcp.js';

/**
 * Zod validation for `AgentDefinition.nativeTooling` (ADR-0008 D3).
 *
 * Boundary rules that matter:
 *   - `true` is the zero-override builtin alias; `false` disables the builtin; an
 *     overrides object customizes it; a full `McpServerConfig` REPLACES it.
 *   - `{fs:{root:42}}` MUST be rejected — `root` is a string, and a non-transport
 *     object only matches the (strict) overrides shape.
 *   - The overrides objects are STRICT: an accidental `transport` key routes the
 *     value to `mcpServerConfigSchema` instead of being silently stripped.
 *   - `askPolicy` is accepted for boundary compatibility but is retired (ADR-0008
 *     D6): the ask chain is fixed and the only knob is `hitl`.
 */

export const permissionActionSchema = z.enum(['allow', 'ask', 'deny']);

export const permissionRuleMapSchema = z.record(
  z.string(),
  permissionActionSchema
);

export const fsBuiltinOverridesSchema = z.strictObject({
  root: z.string().optional(),
  readOnly: z.boolean().optional(),
  permissions: permissionRuleMapSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

export const shellBuiltinOverridesSchema = z.strictObject({
  root: z.string().optional(),
  permissions: permissionRuleMapSchema.optional(),
  allowCommands: z.array(z.string()).optional(),
  denyCommands: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const dispatchBuiltinOverridesSchema = z.strictObject({
  permissions: permissionRuleMapSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

// A custom `McpServerConfig` is tried FIRST so a transport-bearing object is never
// misread as an (empty) overrides object by key-stripping.
export const fsToolConfigSchema = z.union([
  mcpServerConfigSchema,
  fsBuiltinOverridesSchema,
  z.boolean(),
]);

export const shellToolConfigSchema = z.union([
  mcpServerConfigSchema,
  shellBuiltinOverridesSchema,
  z.boolean(),
]);

export const dispatchToolConfigSchema = z.union([
  mcpServerConfigSchema,
  dispatchBuiltinOverridesSchema,
  z.boolean(),
]);

/** One link of the fixed ask-resolution chain (ADR-0008 D6). */
export const askResolutionSchema = z.enum(['suspend', 'escalate', 'deny']);

/** @deprecated: see {@link askPolicySchema} doc. */
export const askPolicySchema = z.object({
  order: z.array(askResolutionSchema),
  escalateTo: z.literal('parent'),
});

export const nativeToolingSchema = z.object({
  fs: fsToolConfigSchema.optional(),
  shell: shellToolConfigSchema.optional(),
  dispatch: dispatchToolConfigSchema.optional(),
  hitl: z.boolean().optional(),
  askPolicy: askPolicySchema.optional(),
});
