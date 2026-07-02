import type { ToolDefinition } from '../providers/types.js';

/**
 * How tool definitions reach the provider API.
 *
 * - "names" (default): the API `tools` array carries slim definitions — name,
 *   a one-line description, and a permissive input schema. The authoritative
 *   documentation (full descriptions + parameter schemas) is prepended to the
 *   system message instead, where it forms a stable, provider-cacheable prefix
 *   and is paid for once instead of re-tokenized as JSON schema every turn.
 * - "full": complete JSON-schema definitions in the API tools array
 *   (pre-existing behavior).
 *
 * Measured basis (provider-call-audit.md): the filesystem MCP server's ~8 tool
 * schemas cost ~3,200 tokens per turn as API tool definitions.
 */
export type ToolAdvertisementMode = 'names' | 'full';

/** Max length of the one-line description kept on name-only definitions. */
const NAME_ONLY_DESCRIPTION_LIMIT = 140;

/**
 * Loose structural view of a JSON-schema node — only what the doc renderer
 * reads. MCP servers ship arbitrary schemas; every access is defensive.
 */
interface JsonSchemaNode {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  description?: unknown;
  enum?: unknown;
  items?: unknown;
}

/**
 * First non-empty line of a tool description, truncated with an ellipsis.
 * Used for the slim description on name-only definitions.
 */
function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > NAME_ONLY_DESCRIPTION_LIMIT
    ? `${line.slice(0, NAME_ONLY_DESCRIPTION_LIMIT - 1)}…`
    : line;
}

/** Human-readable type label for a schema property. */
function describeType(node: JsonSchemaNode): string {
  if (Array.isArray(node.enum)) {
    return `enum(${node.enum.map((v) => JSON.stringify(v)).join(' | ')})`;
  }
  if (Array.isArray(node.type)) {
    return node.type.map(String).join(' | ');
  }
  if (node.type === 'array') {
    const items = (node.items ?? {}) as JsonSchemaNode;
    return `${typeof items.type === 'string' ? items.type : 'any'}[]`;
  }
  return typeof node.type === 'string' ? node.type : 'any';
}

/**
 * Render the full tool documentation block prepended to the system message in
 * "names" mode. Tools are sorted by name so the block is byte-identical across
 * turns AND across tasks with the same tool set — maximizing provider
 * prompt-cache hits.
 */
export function renderToolPromptDoc(tools: ToolDefinition[]): string {
  const sections = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const schema = (tool.inputSchema ?? {}) as JsonSchemaNode;
      const properties = schema.properties ?? {};
      const required = new Set(
        Array.isArray(schema.required) ? (schema.required as string[]) : []
      );

      const params = Object.entries(properties).map(([key, raw]) => {
        const node = (raw ?? {}) as JsonSchemaNode;
        const requiredTag = required.has(key) ? ', required' : '';
        const description =
          typeof node.description === 'string' && node.description.trim()
            ? ` — ${node.description.trim()}`
            : '';
        return `- \`${key}\` (${describeType(node)}${requiredTag})${description}`;
      });

      const lines = [`### ${tool.name}`];
      const toolDescription = tool.description?.trim();
      if (toolDescription) {
        lines.push(toolDescription);
      }
      lines.push(
        params.length > 0
          ? ['Parameters:', ...params].join('\n')
          : 'Parameters: none'
      );
      return lines.join('\n');
    });

  return [
    '## Available Tools',
    '',
    'The API tool list advertises tool names only. The authoritative argument',
    'schemas are documented below — construct tool-call arguments exactly from',
    'these definitions.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * Slim, name-only tool definitions for the API `tools` array in "names" mode.
 * The permissive schema keeps every OpenAI-compatible and Anthropic endpoint
 * happy (both require a `parameters`/`input_schema` object) while argument
 * construction is guided by the system-prompt documentation block.
 */
export function toNameOnlyTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ? firstLine(tool.description) : '',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  }));
}
