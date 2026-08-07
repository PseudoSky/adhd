// tool-description.ts — BUG-APIGEN-020 / BUG-APIGEN-MCP-DISCOVERABILITY-001
// support.
//
// Builds the human-visible MCP tool `description` string for a composed
// schema entry. Single source of truth shared by:
//   - the mcp plugin's `generate()` (bakes the description into the
//     generated `index.ts` toolMetas at generate time — deterministic,
//     zero runtime cost), and
//   - the mcp plugin's `run()` (dynamic in-process server) — same output
//     for the same inputs, for BOTH regular (extracted-operation) tools
//     AND `--use` mount-derived tools (e.g. `apigen-plugin-batch`'s
//     `_batch/<kind>`).
//
// Combines, in order:
//   1. an optional caller-supplied override (e.g. a `toolDescriptions`
//      plugin option),
//   2. the auto-generated data-envelope calling-convention note that
//      `composeSchemas` (BUG-APIGEN-020) stamps onto the composed schema's
//      `input.description` (present only for `{data:{...}}`-enveloped
//      extracted operations — genuinely absent for mount ops, which have no
//      envelope by design; see `apigen-core-client/src/lib/batch.ts`), and
//   3. a concrete, schema-derived worked example (BUG-APIGEN-MCP-
//      DISCOVERABILITY-001) synthesized off `schema.input` itself via
//      `@adhd/apigen-base-logical`'s `renderExampleNote` — the SAME shared
//      primitive `validate-layer.ts` uses to append a passing-shape example
//      to a validation failure message, so the tool description and the
//      error message never drift out of sync with each other.
//
// Because the example is synthesized directly off whatever `schema.input`
// actually is, this produces the RIGHT example shape automatically for
// both calling conventions in this repo — the `{data:{...}}` envelope for
// extracted operations and the flat, non-enveloped shape for mount ops —
// without hardcoding which one applies where.
//
// Falls back to the bare tool name when none of the three parts are present.

import { renderExampleNote } from '@adhd/apigen-base-logical';
import type { JsonSchemaLike } from '@adhd/apigen-base-logical';

/** The minimal shape this module reads off a composed (or mount) schema entry. */
export interface ToolDescriptionSchema {
  input?: JsonSchemaLike & {
    description?: unknown;
  };
}

/**
 * Builds the description shown for tool `name` in an MCP `tools/list`
 * response.
 *
 * @param name - The MCP tool name (used as the final fallback).
 * @param schema - The function's composed (or mount) schema; `input` is
 *   read both for the envelope/data-wrapper documentation
 *   (`input.description`, when present) and for synthesizing a concrete
 *   worked example off its actual shape.
 * @param override - An optional caller-supplied description (e.g. from the
 *   `toolDescriptions` plugin option), prepended when present.
 */
export function buildToolDescription(
  name: string,
  schema: ToolDescriptionSchema | undefined,
  override?: string
): string {
  const envelopeDoc =
    typeof schema?.input?.description === 'string'
      ? schema.input.description
      : undefined;
  const exampleDoc = renderExampleNote(schema?.input);
  const parts = [override, envelopeDoc, exampleDoc].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  return parts.length > 0 ? parts.join(' — ') : name;
}
