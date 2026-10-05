/**
 * import-agents.ts — import Claude Code subagent personas (`~/.claude/agents/*.md`)
 * into the agent-mcp registry (backlog 09e84a88).
 *
 * Each persona file is YAML frontmatter (`name`, `description`, `model`, …)
 * followed by the agent's system-prompt body. Nothing in the repo read these
 * into the registry before, so 60 named personas were unreachable as
 * `agent_read`-able definitions.
 *
 * The import drives the REAL agent-mcp tool surface (`agent_read` →
 * `agent_create` on miss, `agent_update` on hit) through an injected
 * `IAgentMcpToolCaller` — so production uses a real `AgentMcpRunner` and tests
 * inject a fake at the external MCP boundary (the permitted mock).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The minimal agent-mcp tool surface this importer drives. `AgentMcpRunner`
 *  satisfies it structurally (`callTool<T>(name, args)`). */
export interface IAgentMcpToolCaller {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface IImportedPersona {
  name: string;
  description?: string;
  model?: string;
  /** The markdown body after the frontmatter — the agent's system prompt. */
  body: string;
  /** Basename of the source file (provenance). */
  file: string;
}

export interface IImportAgentsResult {
  created: string[];
  updated: string[];
  /** Files with no parseable frontmatter, or left alone by `update: false`. */
  skipped: string[];
  errors: Array<{ file: string; message: string }>;
  /**
   * Non-fatal frontmatter parse notes (e.g. an indented/structured line that
   * could not be attached to a key). Empty when every file parsed cleanly.
   */
  warnings: string[];
}

export interface IImportAgentsOptions {
  /** Provider written to `agent_create`/`agent_update`. Default: `claudecli`
   *  (optionally carrying the persona's `model`). */
  provider?: Record<string, unknown>;
  /** Default `mcpServers` written on create. Omitted ⇒ none. */
  mcpServers?: Record<string, unknown>;
  /** Update personas that already exist. Default `true`. */
  update?: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** A YAML block-scalar header: `|`, `>`, and either with a chomping indicator. */
const BLOCK_SCALAR_HEADER = /^[|>][+-]?$/;

/** Strip a single layer of matching surrounding quotes, if present. */
function unquote(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Leading whitespace width of a line (spaces + tabs, counted as chars). */
function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}

/**
 * Parse one persona file. Returns `null` when it has no `---` frontmatter.
 *
 * Handles the simple `key: value` shape plus the two structured YAML shapes a
 * real Claude Code persona can carry: block scalars (`description: |` / `>`)
 * and block sequences (`key:` followed by indented `- item` lines). Any
 * remaining indented/structured line that cannot be attached to a key is
 * surfaced through the optional `warn` callback rather than silently dropped
 * (the pre-fix naive `indexOf(':')` parser truncated such values to `''`).
 */
export function parsePersona(
  file: string,
  content: string,
  warn?: (message: string) => void
): IImportedPersona | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;

  const lines = match[1].split(/\r?\n/);
  const meta: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;

    // Frontmatter keys start at column 0. An indented line here is structured
    // content not attached to a key (an unconsumed block/list) — report it.
    if (indentOf(rawLine) > 0) {
      warn?.(
        `line ${i + 1}: indented content with no preceding key — ignored: ${JSON.stringify(rawLine)}`
      );
      continue;
    }

    const sep = rawLine.indexOf(':');
    if (sep === -1) {
      warn?.(`line ${i + 1}: not a "key: value" pair — ignored: ${JSON.stringify(rawLine)}`);
      continue;
    }
    const key = rawLine.slice(0, sep).trim();
    if (!key) {
      warn?.(`line ${i + 1}: empty key — ignored: ${JSON.stringify(rawLine)}`);
      continue;
    }
    const inlineValue = rawLine.slice(sep + 1).trim();

    // Block scalar: `key: |` / `key: >` (optionally with `-`/`+` chomping).
    if (BLOCK_SCALAR_HEADER.test(inlineValue)) {
      const folded = inlineValue.startsWith('>');
      const blockLines: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== '' && indentOf(l) === 0) break; // next top-level key
        blockLines.push(l.replace(/^[ \t]+/, ''));
      }
      i = j - 1;
      while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') {
        blockLines.pop();
      }
      meta[key] = folded ? blockLines.join(' ') : blockLines.join('\n');
      continue;
    }

    // Empty inline value → a block sequence (`- item` lines), or a genuinely
    // empty value. Blank lines between items are tolerated.
    if (inlineValue === '') {
      const items: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const m = /^\s*-\s+(.*)$/.exec(l);
        if (!m) break;
        items.push(unquote(m[1].trim()));
      }
      if (items.length > 0) {
        i = j - 1;
        meta[key] = items.join('\n');
        continue;
      }
      meta[key] = '';
      continue;
    }

    meta[key] = unquote(inlineValue);
  }

  const fallbackName = file.replace(/.*[/\\]/, '').replace(/\.md$/, '');
  const name = meta['name']?.trim() || fallbackName;

  return {
    name,
    description: meta['description'],
    model: meta['model'],
    body: match[2].trim(),
    file,
  };
}

function isAgentNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'AGENT_NOT_FOUND'
  );
}

function providerFor(
  persona: IImportedPersona,
  override?: Record<string, unknown>
): Record<string, unknown> {
  if (override) return override;
  const provider: Record<string, unknown> = { type: 'claudecli' };
  if (persona.model) provider['model'] = persona.model;
  return provider;
}

/**
 * Import every `*.md` persona under `dir`. Idempotent: existing agents are
 * updated (unless `update: false`), missing ones created.
 */
export async function importClaudeAgents(
  dir: string,
  client: IAgentMcpToolCaller,
  opts: IImportAgentsOptions = {}
): Promise<IImportAgentsResult> {
  const result: IImportAgentsResult = {
    created: [],
    updated: [],
    skipped: [],
    errors: [],
    warnings: [],
  };

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  for (const file of files) {
    const filePath = join(dir, file);
    let persona: IImportedPersona | null;
    try {
      persona = parsePersona(file, readFileSync(filePath, 'utf8'), (message) =>
        result.warnings.push(`${file}: ${message}`)
      );
    } catch (err) {
      result.errors.push({
        file,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!persona) {
      result.skipped.push(file);
      continue;
    }

    const definition: Record<string, unknown> = {
      description: persona.description,
      systemPrompt: persona.body,
      provider: providerFor(persona, opts.provider),
    };
    if (opts.mcpServers) definition['mcpServers'] = opts.mcpServers;

    try {
      let exists = true;
      try {
        await client.callTool('agent_read', { name: persona.name });
      } catch (err) {
        if (isAgentNotFound(err)) exists = false;
        else throw err;
      }

      if (exists) {
        if (opts.update === false) {
          result.skipped.push(file);
          continue;
        }
        await client.callTool('agent_update', {
          name: persona.name,
          patch: definition,
        });
        result.updated.push(persona.name);
      } else {
        await client.callTool('agent_create', {
          name: persona.name,
          ...definition,
        });
        result.created.push(persona.name);
      }
    } catch (err) {
      result.errors.push({
        file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
