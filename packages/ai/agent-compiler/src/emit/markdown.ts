// ──────────────────────────────────────────────
// yaml_frontmatter emitter (claude_code / header_format = 'yaml_frontmatter')
//
// Renders the YAML frontmatter block then the composed markdown body.
//
// Field set and ordering are FROZEN per Decision B.1 (decisions.md):
//
//   ---
//   name: <agent.slug>
//   description: <agent.description>
//   tools: <comma-joined resolved platform aliases, in agent_tools grant order>
//   model: <resolved platform model alias>
//   ---
//
//   <body: resolveComposition sections joined in junction order, "\n\n" between>
//
// Rules:
//   - `tools:` — comma-joined platformAlias values from resolveTools (never
//     canonical names); OMITTED entirely when the resolved list is empty
//     (Decision B.1: "no tools: line").
//   - `model:` — OMITTED when resolveModel returns '' (no model_hint).
//   - Policy constraints — rendered as a `## Policies` section APPENDED to the
//     body (claude_code frontmatter has no policy field); the text is the
//     resolved Constraint.text (template description).  When there are no
//     constraints, no section is added.
//   - `description:` — sourced from the agent row's description; rendered as an
//     empty string if the agent has no description (never omitted — Claude Code
//     surfaces this field in the picker UI).
//
// [inv:platform-shaped-observable] — the consumer-visible observable is the
// frontmatter `tools:` line equalling the resolved aliases; a canonical-name
// leak makes the frontmatter.tools assertion go red.
//
// [def:junction-order] — sections emitted in the returned array order
// (ascending position), never re-sorted here.
// ──────────────────────────────────────────────

import type { ResolvedTool } from '../resolve/tools.js';
import type { Constraint } from '../resolve/policy.js';

/** Inputs to the yaml_frontmatter emitter. */
export interface YamlFrontmatterInput {
  /** Agent slug — the `name:` frontmatter field. */
  agentSlug: string;
  /** Agent description — the `description:` frontmatter field. */
  description: string;
  /** Resolved platform tool aliases (e.g. ['Read', 'Grep', 'WebSearch']). */
  tools: ResolvedTool[];
  /** Resolved platform model alias (e.g. 'opus'), or '' when absent. */
  model: string;
  /**
   * Body sections in junction order (ascending position), each being the
   * raw content of one resolved component.  Joined with '\n\n' between
   * sections per Decision B.1.
   */
  bodySections: string[];
  /** Effective policy constraints (direct + inherited). */
  constraints: Constraint[];
}

/**
 * Emit a claude_code `yaml_frontmatter` platform artifact.
 *
 * Returns a string that STARTS with `---` (the opening YAML fence), followed
 * by the frozen field set, the closing fence, a blank line, then the composed
 * markdown body (sections joined with '\n\n') with an appended `## Policies`
 * block when policy constraints exist.
 *
 * @param input - Resolved compiler inputs; all fields already platform-shaped.
 * @returns Flat markdown string ready to write to a `.md` file or emit to
 *          stdout as the claude_code system prompt.
 */
export function emitYamlFrontmatter(input: YamlFrontmatterInput): string {
  const { agentSlug, description, tools, model, bodySections, constraints } = input;

  // ── Frontmatter fields ────────────────────────────────────────────────────
  const lines: string[] = ['---'];

  lines.push(`name: ${agentSlug}`);
  lines.push(`description: ${description}`);

  // tools: — only emitted when there is at least one resolved alias.
  // Decision B.1: "An agent with no grants emits no tools: line (NOT tools: empty)".
  if (tools.length > 0) {
    const aliasLine = tools.map(t => t.platformAlias).join(', ');
    lines.push(`tools: ${aliasLine}`);
  }

  // model: — omitted when model resolves to '' (no model_hint or no binding).
  if (model) {
    lines.push(`model: ${model}`);
  }

  lines.push('---');

  // ── Body ──────────────────────────────────────────────────────────────────
  // Sections joined with '\n\n' per Decision B.1.
  // bodySections contains already-rendered component content in junction order
  // — the compiler must NOT re-sort or re-filter here.
  const bodyParts: string[] = [...bodySections];

  // ── Policy block ──────────────────────────────────────────────────────────
  // Constraints fold into the BODY (not frontmatter) for claude_code.
  // Rendered as '## Policies' followed by bullet items.
  // [def:policy-constraint], Decision B.1: "policy constraint block appended to the body"
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

  // Join sections with '\n\n' (Decision B.1).
  const body = bodyParts.join('\n\n');

  // Final artifact: frontmatter block + blank line + body.
  return lines.join('\n') + '\n\n' + body + '\n';
}
