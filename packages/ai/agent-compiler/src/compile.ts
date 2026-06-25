// ──────────────────────────────────────────────
// compileAgent — public orchestrator.
//
// Turns an agent definition + runtime context into a flat, platform-shaped
// artifact by composing the four resolve layers and dispatching to the
// platform's header builder.
//
// Decision B (decisions.md) defines three header builders keyed on a
// platform's `header_format` column:
//
//   yaml_frontmatter → emit/markdown.ts  (claude_code)
//   json_object      → emit/json.ts      (claude_api / openai / bedrock)
//   none             → body text only    (cursor / vscode)
//
// The builder is selected by DATA (header_format), never by a hard-coded
// platform name check.  Adding a platform that shares an existing
// header_format requires no code change here.
//
// \n\n section separator advisory (carry-forward, decisions.md Decision B.1):
//   resolve/composition.ts:72 joins body sections with a single '\n'.
//   composition.ts is read-only.  To produce the '\n\n'-separated body
//   mandated by Decision B.1, this function calls CompositionStore.resolveComposition
//   directly and owns the join, bypassing resolveBody's pre-joined string.
//   This is the emit-layer fix authorised by the advisory — no composition.ts
//   edit required.
//
// [def:compile-input]  — {agentSlug, platform, context, db}
// [def:composed-output] — {id, content, tools, componentVersions}
// [inv:one-db-handle]  — ONE shared SQLite handle, all four table prefixes.
// [inv:real-rows-not-mocks] — the caller seeds real rows; this function
//   reads them through the upstream stores.
// ──────────────────────────────────────────────

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { AgentStore, CompositionStore } from '@adhd/agent-registry';
import type { CompositionContext } from '@adhd/agent-registry';
import {
  ToolStore,
  BindingStore,
} from '@adhd/agent-tool-registry';
import { ToolFormatStore, emitToolsForProvider } from '@adhd/agent-provider';
import type { ToolFormatLookup } from '@adhd/agent-provider';

import { resolveTools }             from './resolve/tools.js';
import { resolveModel }             from './resolve/model.js';
import { resolvePolicyConstraints } from './resolve/policy.js';
import { emitYamlFrontmatter }      from './emit/markdown.js';
import { emitJsonObject }           from './emit/json.js';
import type { ComponentVersionMap } from './resolve/composition.js';
import type { StructuredTool }      from './emit/json.js';

// ──────────────────────────────────────────────
// Public types ([def:compile-input] / [def:composed-output])
// ──────────────────────────────────────────────

/** Input to compileAgent ([def:compile-input]). */
export interface CompileInput {
  /** Slug of the agent to compile. */
  agentSlug: string;
  /** Target platform id (e.g. 'claude_code', 'claude_api'). */
  platform: string;
  /** Runtime context key/value map for context-conditioned components. */
  context?: CompositionContext;
  /** Shared registry Drizzle handle (all four table prefixes — [inv:one-db-handle]). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BetterSQLite3Database<any>;
}

/** Return value of compileAgent ([def:composed-output]). */
export interface CompiledAgent {
  /**
   * `composed_prompts` row id (audit/cache handle).
   * null until the composed-prompt-caching state wires the cache write.
   */
  id: null;
  /** Flat platform artifact (markdown for claude_code, JSON string for claude_api/openai). */
  content: string;
  /**
   * Resolved platform-shaped tools.
   * For claude_code: string[] of aliases (e.g. ['Read','Grep','WebSearch']).
   * For claude_api: StructuredTool[] (EmittedTool[]) shaped for the API.
   * For none-format: [] (platform does not support tool selection).
   */
  tools: string[] | StructuredTool[];
  /**
   * Map of componentSlug → resolvedVersion for cache-key computation
   * ([def:context-hash]).
   */
  componentVersions: ComponentVersionMap;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

/**
 * Look up the `header_format` for a platform from `tool_platform_bindings.platforms`.
 * Returns the platform's `headerFormat` column, or 'none' if no row is found.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPlatformHeaderFormat(db: BetterSQLite3Database<any>, platform: string): string {
  const bindingStore = new BindingStore(db);
  // BindingStore.readPlatform throws PLATFORM_NOT_FOUND when absent — treat
  // an unknown platform as 'none' (body-only compile).
  try {
    const p = bindingStore.readPlatform(platform);
    return p.headerFormat;
  } catch {
    // Unknown platform — treat as 'none' (body-only).
    return 'none';
  }
}

/**
 * Extract body sections (in junction order) and componentVersions directly from
 * CompositionStore — bypassing resolveBody's '\n'-joined string so we can
 * join sections with '\n\n' as Decision B.1 mandates.
 *
 * This is the emit-layer fix for the advisory noted in decisions.md.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBodyParts(
  db: BetterSQLite3Database<any>,
  agentSlug: string,
  context: CompositionContext
): { bodySections: string[]; componentVersions: ComponentVersionMap } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new CompositionStore(db as any);
  const resolved = store.resolveComposition(agentSlug, context);

  const componentVersions: ComponentVersionMap = {};
  const bodySections: string[] = [];

  for (const rc of resolved) {
    bodySections.push(rc.component.content);
    componentVersions[rc.componentSlug] = rc.resolvedVersion;
  }

  return { bodySections, componentVersions };
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Compile an agent to a flat, platform-shaped artifact.
 *
 * Orchestrates the four resolve layers:
 *   1. body + componentVersions — CompositionStore.resolveComposition (junction order)
 *   2. tools                    — resolveTools (platform aliases)
 *   3. model                    — resolveModel (platform binding or canonical fallback)
 *   4. constraints              — resolvePolicyConstraints (direct + inherited)
 *
 * Then dispatches on the platform's `header_format` column to the matching
 * emit function.  The `id` field is null until `composed-prompt-caching`
 * wires the cache write ([def:composed-output]).
 *
 * @param input - Agent slug, target platform, runtime context, shared DB handle.
 * @returns Compiled platform artifact plus metadata.
 *
 * @throws {AgentError}       AGENT_NOT_FOUND — agentSlug not in registry_agents.
 * @throws {CompositionError} REQUIRED_COMPONENT_EXCLUDED — a required component
 *   was excluded by the runtime context.
 */
export function compileAgent(input: CompileInput): CompiledAgent {
  const { agentSlug, platform, context = {}, db } = input;

  // ── 1. Agent metadata (description for frontmatter, model_hint for model step) ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentStore = new AgentStore(db as any);
  const agent = agentStore.read(agentSlug);

  // ── 2. Determine header_format from the platform row ────────────────────
  const headerFormat = getPlatformHeaderFormat(db, platform);

  // ── 3. Body sections in junction order with '\n\n' separator ────────────
  // Direct call to CompositionStore — bypasses resolveBody's '\n' join so
  // we can apply Decision B.1's '\n\n' between sections at the emit layer.
  const { bodySections, componentVersions } = extractBodyParts(db, agentSlug, context);

  // ── 4. Resolve tools (platform aliases) ─────────────────────────────────
  const resolvedTools = resolveTools(db, agentSlug, platform);

  // ── 5. Resolve model ─────────────────────────────────────────────────────
  const model = resolveModel(db, agentSlug, platform);

  // ── 6. Resolve policy constraints ────────────────────────────────────────
  const constraints = resolvePolicyConstraints(db, agentSlug);

  // ── 7. Dispatch on header_format ─────────────────────────────────────────

  // yaml_frontmatter (claude_code) ──────────────────────────────────────────
  if (headerFormat === 'yaml_frontmatter') {
    const content = emitYamlFrontmatter({
      agentSlug,
      description: agent.description,
      tools:        resolvedTools,
      model,
      bodySections,
      constraints,
    });

    // Tools return: string[] of platform aliases for claude_code.
    const toolAliases = resolvedTools.map(t => t.platformAlias);

    return { id: null, content, tools: toolAliases, componentVersions };
  }

  // json_object (claude_api / openai / bedrock) ─────────────────────────────
  if (headerFormat === 'json_object') {
    // Build structured tool array for the API.
    // We construct minimal ToolDefinition objects from the tool catalog so
    // emitToolsForProvider can shape them.  inputSchema defaults to {} since
    // the registry doesn't store JSON schemas for tool grants.
    const toolStore = new ToolStore(db);
    const toolFormatStore = new ToolFormatStore(db);
    const lookup: ToolFormatLookup = (providerId, canonicalTool) =>
      toolFormatStore.getShape(providerId, canonicalTool);

    // Map the target platform id to the provider id (Decision B.2: tools shaped
    // via provider_tool_formats).  claude_api → 'anthropic' is the seed mapping
    // from SEED_DATA.md §5; openai → 'openai'.  Unknown platforms default to
    // the platform id itself as the provider id.
    const platformToProvider: Record<string, string> = {
      claude_api: 'anthropic',
      openai:     'openai',
      bedrock:    'bedrock',
    };
    const providerId = platformToProvider[platform] ?? platform;

    // Build ToolDefinition[] from the resolved (available) tools.
    const toolDefinitions = resolvedTools.map(rt => {
      let description = '';
      try {
        const catalogTool = toolStore.read(rt.canonicalName);
        description = catalogTool.description;
      } catch {
        // No catalog row — use the canonical name as a fallback description.
        description = rt.canonicalName;
      }
      return {
        name:        rt.canonicalName,
        description,
        inputSchema: {} as Record<string, unknown>,
      };
    });

    // emitToolsForProvider shapes each tool per the provider_tool_formats row.
    // Double-cast via unknown: EmittedTool[] (EmittedServerSideTool lacks an
    // index signature) → unknown[] → StructuredTool[].  Both types are
    // compatible at runtime — all EmittedTool shapes are plain objects.
    const emittedTools = emitToolsForProvider(toolDefinitions, providerId, lookup) as unknown as StructuredTool[];

    const content = emitJsonObject({
      agentSlug,
      bodySections,
      constraints,
      tools:          resolvedTools,
      structuredTools: emittedTools,
      model,
    });

    return { id: null, content, tools: emittedTools, componentVersions };
  }

  // none (cursor / vscode) — body only, no tools declaration ─────────────────
  // Decision B.3: content = flat body + policy block, tools: [].
  const bodyParts: string[] = [...bodySections];
  if (constraints.length > 0) {
    const policyLines = ['## Policies', ''];
    for (const c of constraints) {
      const prefix = c.inheritedFrom ? `(inherited from ${c.inheritedFrom}) ` : '';
      policyLines.push(`- ${prefix}${c.text}`);
    }
    bodyParts.push(policyLines.join('\n'));
  }
  const content = bodyParts.join('\n\n') + '\n';

  return { id: null, content, tools: [], componentVersions };
}
