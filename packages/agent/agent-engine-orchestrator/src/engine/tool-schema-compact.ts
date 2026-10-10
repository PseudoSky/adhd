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
 * `canonicalizeToolDefinitions` (9ed453c1 CACHE) makes the advertised block byte-stable ACROSS
 * tasks: third-party servers render allow-lists from unordered sets (`mcp-shell-server` builds
 * `Allowed commands: a, b, c` from a Python `set`, whose order follows the per-process
 * PYTHONHASHSEED), so the serialized `tools` array — the head of the cached prompt prefix —
 * differed on every spawn and the whole prefix was re-written each task.
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

/**
 * A description line of the form `Allowed <noun phrase>: item, item, ...` — the shape third-party
 * servers use to print an allow-list rendered from an unordered collection
 * (`Allowed commands: ...`, `Allowed patterns: ...`). Only the whole-line match is rewritten.
 */
const ALLOW_LIST_LINE = /^(Allowed [A-Za-z][A-Za-z ]*: )(.+)$/gm;

/** Code-unit order: locale-independent, so every host and Node version sorts identically. */
const byCodeUnit = (a: string, b: string): number => Number(a > b) - Number(a < b);

/**
 * Sorts the items of every `Allowed <what>: a, b, c` line in a tool description. The set of items
 * and every other character of the text are unchanged; the result is a fixed point (idempotent).
 */
export function canonicalizeDescription(description: string): string {
  return description.replace(ALLOW_LIST_LINE, (_line, head: string, list: string) =>
    head + list.split(', ').sort(byCodeUnit).join(', ')
  );
}

/**
 * Returns the tool list with unordered-collection renderings in descriptions put in a canonical
 * order, so the same configured server advertises byte-identical tool definitions on every spawn
 * (stable prompt-cache prefix). Applied to the engine's tool list BEFORE it fans out to any
 * provider path (`full`/`names` advertisement and the claudecli loopback bridge).
 *
 * @param tools - the tools the engine is about to advertise
 * @returns new tool definitions (inputs are not mutated)
 */
export function canonicalizeToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) =>
    typeof tool.description === 'string'
      ? { ...tool, description: canonicalizeDescription(tool.description) }
      : { ...tool }
  );
}
