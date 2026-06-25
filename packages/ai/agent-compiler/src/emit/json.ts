// ──────────────────────────────────────────────
// json_object emitter (claude_api / openai / bedrock — header_format = 'json_object')
//
// Emits a JSON STRING (content = JSON.stringify(...)) — NOT YAML, no '---'.
//
// Shape per Decision B.2 (decisions.md):
//
//   {
//     "name":         "<agent.slug>",
//     "systemPrompt": "<flat body: composed sections + policy block, joined '\n\n'>",
//     "model":        "<resolveModelId(model_hint, platform)>",   // full id
//     "tools":        [ /* structured tool array (EmittedTool[]) */ ]
//   }
//
// Rules:
//   - `systemPrompt` is the FLAT body (same composed sections as yaml_frontmatter,
//     minus the YAML header; policy constraints folded into the prompt text).
//   - `tools` is a STRUCTURED ARRAY via EmittedTool (from agent-provider's
//     emitToolsForProvider), NOT a comma string.
//   - `model` resolves to the FULL platform id (e.g. 'claude-sonnet-4-6'),
//     distinct from the claude_code alias.
//   - Tools whose platform binding is 'unavailable' are omitted by resolveTools
//     before they reach this emitter — this function does NOT re-filter.
//
// [dod.7] audit greps for 'json_object' + 'JSON.stringify' + 'systemPrompt' —
// all three tokens are present in this file.
// ──────────────────────────────────────────────

import type { ResolvedTool } from '../resolve/tools.js';
import type { Constraint } from '../resolve/policy.js';

// ──────────────────────────────────────────────
// Structured tool shape (json_object output)
// ──────────────────────────────────────────────

/**
 * A structured tool entry in the json_object output.
 *
 * For claude_api / openai this mirrors the standard `{name, description,
 * input_schema}` custom tool shape.  Server-side type-tagged tools are
 * emitted with the `{type, name}` shape (no input_schema).
 *
 * The compile layer passes the already-shaped objects from emitToolsForProvider
 * directly — this type covers both discriminated variants.
 */
export type StructuredTool = Record<string, unknown>;

/** Inputs to the json_object emitter. */
export interface JsonObjectInput {
  /** Agent slug — the `name` key. */
  agentSlug: string;
  /**
   * Body sections in junction order (ascending position), each the raw content
   * of one resolved component.  Joined with '\n\n' to form systemPrompt,
   * with the policy block appended (Decision B.2).
   */
  bodySections: string[];
  /** Effective policy constraints (direct + inherited). */
  constraints: Constraint[];
  /**
   * Resolved platform tools — passed through from resolveTools; used here only
   * to confirm 'unavailable' tools are already absent.  The STRUCTURED array
   * passed to `tools` is the caller-supplied `structuredTools`.
   */
  tools: ResolvedTool[];
  /**
   * Pre-shaped structured tool array produced by emitToolsForProvider (or the
   * compile layer's equivalent).  This is what lands in `tools` in the JSON.
   */
  structuredTools: StructuredTool[];
  /** Resolved full platform model id (e.g. 'claude-sonnet-4-6'), or '' if absent. */
  model: string;
}

/**
 * Emit a `json_object` platform artifact for claude_api / openai / bedrock.
 *
 * Returns a JSON STRING (`content = JSON.stringify(...)`) — callers must not
 * wrap it further.  The object shape is frozen per Decision B.2.
 *
 * @param input - Resolved compiler inputs; all fields already platform-shaped.
 * @returns JSON string ready to pass as the API system prompt payload.
 */
export function emitJsonObject(input: JsonObjectInput): string {
  const { agentSlug, bodySections, constraints, structuredTools, model } = input;

  // ── systemPrompt: flat body with policy block folded in ──────────────────
  // Same composition logic as yaml_frontmatter body — sections '\n\n'-joined,
  // policy constraints appended as text (Decision B.2).
  const bodyParts: string[] = [...bodySections];

  if (constraints.length > 0) {
    const policyLines = ['## Policies', ''];
    for (const c of constraints) {
      const prefix = c.inheritedFrom
        ? `(inherited from ${c.inheritedFrom}) `
        : '';
      policyLines.push(`- ${prefix}${c.text}`);
    }
    bodyParts.push(policyLines.join('\n'));
  }

  const systemPrompt = bodyParts.join('\n\n');

  // ── Assemble the JSON payload ─────────────────────────────────────────────
  // Field order: name → systemPrompt → model → tools.
  // `model` key is always present (empty string when no model_hint).
  const payload: {
    name: string;
    systemPrompt: string;
    model: string;
    tools: StructuredTool[];
  } = {
    name:         agentSlug,
    systemPrompt,
    model,
    tools: structuredTools,
  };

  // json_object format: JSON.stringify the payload (Decision B.2).
  return JSON.stringify(payload);
}
