import { z } from 'zod';
import { isAbsolute } from 'node:path';
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
 *   - `fs.root`/`fs.roots` are PORTABLE HINTS (a cwd-relative subpath or a named
 *     alias in the global allowed-root map). An ABSOLUTE path is REJECTED at this
 *     boundary — it welds a host path into a record that must stay reusable
 *     (D4/D8; the fs analogue of the welded-`provider` bug). The resolver also
 *     rejects it (defense in depth).
 */

export const permissionActionSchema = z.enum(['allow', 'ask', 'deny']);

export const permissionRuleMapSchema = z.record(
  z.string(),
  permissionActionSchema
);

/**
 * A portable fs root hint: a cwd-relative subpath, or a named alias resolved via
 * the global allowed-root map. Absolute is rejected here so a definition can
 * never carry a host path (the resolver rejects it too, for a stale/bypassed
 * def). Exported for direct testing.
 */
export const fsRootHintSchema = z
  .string()
  .refine((hint) => !isAbsolute(hint), {
    message:
      'fs root must be a portable hint (a cwd-relative subpath or a named ' +
      'alias in the global allowed-root map), not an absolute path',
  });

export const fsBuiltinOverridesSchema = z.strictObject({
  root: fsRootHintSchema.optional(),
  roots: z.array(fsRootHintSchema).optional(),
  readOnly: z.boolean().optional(),
  permissions: permissionRuleMapSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

export const shellBuiltinOverridesSchema = z.strictObject({
  root: z.string().optional(),
  permissions: permissionRuleMapSchema.optional(),
  allowCommands: z.array(z.string()).optional(),
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
