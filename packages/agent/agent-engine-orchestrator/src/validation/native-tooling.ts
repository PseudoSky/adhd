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
 *     rejects it (defense in depth). `shell.root` uses the SAME contract (the
 *     ONE portable-hint schema, {@link fsRootHintSchema}) — an absolute/`..`/alias
 *     `shell.root` is rejected/mapped exactly like `fs.root` (#3).
 *   - The shell override carries the adopted server's argv allowlist BOTH as
 *     exact NAMES (`allowCommands`) and as regex NAMES (`allowPatterns`, its
 *     `ALLOW_PATTERNS`, `fullmatch` over `command[0]`) — both are config
 *     passthroughs, never a per-command permission map (ADR-0008 D5). A pattern
 *     containing a comma is REJECTED: the harness CSV-joins the list into one env
 *     value, so a comma inside a pattern would split/corrupt its neighbour (#9).
 */

export const permissionActionSchema = z.enum(['allow', 'ask', 'deny']);

export const permissionRuleMapSchema = z.record(
  z.string(),
  permissionActionSchema
);

/**
 * A portable fs/shell root hint: a cwd-relative subpath, or a named alias
 * resolved via the global allowed-root map. Absolute is rejected here so a
 * definition can never carry a host path (the resolver rejects it too, for a
 * stale/bypassed def). Exported for direct testing. Used for BOTH `fs.root(s)`
 * and `shell.root` — the ONE portable-hint contract (#3).
 */
export const fsRootHintSchema = z
  .string()
  .refine((hint) => !isAbsolute(hint), {
    message:
      'root must be a portable hint (a cwd-relative subpath or a named ' +
      'alias in the global allowed-root map), not an absolute path',
  });

/**
 * A single shell allow pattern. Rejects a comma because the resolver joins the
 * list into ONE `ALLOW_PATTERNS` env value with `,` (the adopted server's CSV
 * format), so a comma inside a pattern would silently split it and corrupt the
 * neighbouring pattern (#9). The adopted server `re.fullmatch`es each pattern
 * against the whole command NAME; author a comma-free regex.
 */
export const shellAllowPatternSchema = z
  .string()
  .refine((pattern) => !pattern.includes(','), {
    message:
      'allowPatterns entries are CSV-joined into one ALLOW_PATTERNS env value, ' +
      'so a pattern must not contain a comma (it would split the list and ' +
      'corrupt the neighbouring pattern)',
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
  // Same portable-hint contract as `fs.root` (#3): alias-map → absolute-reject
  // → `..`-containment. An absolute shell cwd welds a host path into the record.
  root: fsRootHintSchema.optional(),
  permissions: permissionRuleMapSchema.optional(),
  allowCommands: z.array(z.string()).optional(),
  // Regex passthrough to the adopted server's `ALLOW_PATTERNS` (fullmatch over
  // the command NAME, OR'd with `allowCommands`) — ADR-0008 D5: the harness
  // owns no parser, so these are not validated as regexes here. A comma is
  // rejected (CSV join), see {@link shellAllowPatternSchema}.
  allowPatterns: z.array(shellAllowPatternSchema).optional(),
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
