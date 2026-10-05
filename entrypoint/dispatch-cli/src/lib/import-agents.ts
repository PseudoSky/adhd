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

/** Parse one persona file. Returns `null` when it has no `---` frontmatter. */
export function parsePersona(file: string, content: string): IImportedPersona | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const sep = rawLine.indexOf(':');
    if (sep === -1) continue;
    const key = rawLine.slice(0, sep).trim();
    let value = rawLine.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
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
  };

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  for (const file of files) {
    const filePath = join(dir, file);
    let persona: IImportedPersona | null;
    try {
      persona = parsePersona(file, readFileSync(filePath, 'utf8'));
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
