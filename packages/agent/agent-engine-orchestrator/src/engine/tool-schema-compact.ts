/**
 * `tool-schema-compact.ts` — token-lean tool advertisement (9ed453c1 CTX).
 *
 * `z.toJSONSchema` (Zod 4) emits the full RFC-4122 regular expression next to every
 * `format: "uuid"` / `"date-time"` property. The `format` keyword already tells the model what the
 * value is; the regex adds ~180-420 characters per property and is re-sent on EVERY request. The
 * default dispatch surface carried it 12 times (2,644 of 22,380 serialized characters, ~12%).
 *
 * Only a `pattern` that sits beside a well-known `format` is dropped; every other keyword,
 * description and any hand-written `pattern` (no `format`, or an unknown one) is preserved. The
 * authoritative validation still runs on the tool's own input schema at execution time — this
 * only shapes what the model is shown.
 *
 * Pure: never mutates its input.
 */
import type { ToolDefinition } from '../providers/types.js';

/** `format` values whose canonical pattern is redundant with the keyword itself. */
const REDUNDANT_PATTERN_FORMATS: ReadonlySet<string> = new Set([
  'uuid',
  'date-time',
  'date',
  'time',
  'email',
  'uri',
  'ipv4',
  'ipv6',
]);

function compactNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactNode);
  if (node === null || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const dropPattern =
    typeof src['format'] === 'string' &&
    REDUNDANT_PATTERN_FORMATS.has(src['format']) &&
    typeof src['pattern'] === 'string';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (dropPattern && key === 'pattern') continue;
    out[key] = compactNode(value);
  }
  return out;
}

/**
 * Returns the tool list with schema-redundant `pattern` keywords removed.
 *
 * @param tools - the tools the engine is about to advertise
 * @returns new tool definitions (inputs are not mutated)
 */
export function compactToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: compactNode(tool.inputSchema) as ToolDefinition['inputSchema'],
  }));
}
