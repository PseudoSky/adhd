import type { ToolDefinition } from '../providers/types.js';

export type ToolAdvertisementMode = 'names' | 'full';

const NAME_ONLY_DESCRIPTION_LIMIT = 140;

interface JsonSchemaNode {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  description?: unknown;
  enum?: unknown;
  items?: unknown;
}

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
