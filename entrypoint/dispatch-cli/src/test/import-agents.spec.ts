/**
 * import-agents.spec.ts — backlog 09e84a88.
 *
 * `importClaudeAgents` parses persona `*.md` files (frontmatter + body) and
 * drives the REAL agent-mcp tool surface (`agent_read` → `agent_create` on a
 * miss / `agent_update` on a hit). The agent-mcp MCP server is the external
 * boundary here, so it is faked; everything under test (frontmatter parsing,
 * the create/update decision, the exact tool arguments) is real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importClaudeAgents,
  parsePersona,
  type IAgentMcpToolCaller,
} from '../lib/import-agents.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'dispatch-cli');

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

class FakeAgentMcpCaller implements IAgentMcpToolCaller {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly existing: Set<string> = new Set()) {}

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ name, args });
    if (name === 'agent_read') {
      if (this.existing.has(args['name'] as string)) return {} as T;
      const err = new Error(`Agent '${String(args['name'])}' not found`) as Error & {
        code: string;
      };
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }
    return {} as T;
  }
}

const REVIEWER_BODY = 'You are a senior architecture reviewer.\n\nDo the review.';
const DESIGNER_BODY = 'You design APIs.';

let dir: string;

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  dir = fs.mkdtempSync(path.join(TMP_ROOT, 'import-agents-'));
  fs.writeFileSync(
    path.join(dir, 'architect-reviewer.md'),
    `---\nname: architect-reviewer\ndescription: "Reviews architecture"\nmodel: sonnet\n---\n\n${REVIEWER_BODY}\n`
  );
  fs.writeFileSync(
    path.join(dir, 'api-designer.md'),
    `---\nname: api-designer\ndescription: Designs APIs\n---\n\n${DESIGNER_BODY}\n`
  );
  // No frontmatter → must be skipped, never sent to agent-mcp.
  fs.writeFileSync(path.join(dir, 'notes.txt.md'), 'just prose, no frontmatter\n');
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('parsePersona', () => {
  it('extracts name, description, model and the trimmed body', () => {
    const persona = parsePersona(
      'architect-reviewer.md',
      `---\nname: architect-reviewer\ndescription: "Reviews architecture"\nmodel: sonnet\n---\n\n${REVIEWER_BODY}\n`
    );
    expect(persona).not.toBeNull();
    expect(persona?.name).toBe('architect-reviewer');
    expect(persona?.description).toBe('Reviews architecture');
    expect(persona?.model).toBe('sonnet');
    expect(persona?.body).toBe(REVIEWER_BODY);
  });

  it('falls back to the filename when frontmatter has no name', () => {
    const persona = parsePersona('no-name.md', `---\ndescription: x\n---\n\nbody\n`);
    expect(persona?.name).toBe('no-name');
  });

  it('returns null when there is no frontmatter', () => {
    expect(parsePersona('x.md', 'no frontmatter here')).toBeNull();
  });
});

describe('importClaudeAgents (09e84a88)', () => {
  it('creates each persona on a miss with the file body as systemPrompt', async () => {
    const client = new FakeAgentMcpCaller();
    const result = await importClaudeAgents(dir, client, {
      mcpServers: { 'memory-server': { transport: 'sse', url: 'http://x/sse' } },
    });

    expect(result.created.sort()).toEqual(['api-designer', 'architect-reviewer']);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(['notes.txt.md']);
    expect(result.errors).toEqual([]);

    const createFor = (name: string) =>
      client.calls.find(
        (c) => c.name === 'agent_create' && c.args['name'] === name
      );
    const reviewer = createFor('architect-reviewer');
    expect(reviewer?.args['systemPrompt']).toBe(REVIEWER_BODY);
    expect(reviewer?.args['description']).toBe('Reviews architecture');
    expect(reviewer?.args['provider']).toEqual({ type: 'claudecli', model: 'sonnet' });
    expect(reviewer?.args['mcpServers']).toEqual({
      'memory-server': { transport: 'sse', url: 'http://x/sse' },
    });

    // api-designer has no `model` → provider carries only the type.
    expect(createFor('api-designer')?.args['provider']).toEqual({ type: 'claudecli' });
  });

  it('updates (never creates) a persona that already exists', async () => {
    const client = new FakeAgentMcpCaller(new Set(['architect-reviewer']));
    const result = await importClaudeAgents(dir, client);

    expect(result.created).toEqual(['api-designer']);
    expect(result.updated).toEqual(['architect-reviewer']);

    const updates = client.calls.filter((c) => c.name === 'agent_update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args['name']).toBe('architect-reviewer');
    expect((updates[0].args['patch'] as Record<string, unknown>)['systemPrompt']).toBe(
      REVIEWER_BODY
    );
    // Existing agent is updated, never recreated.
    expect(
      client.calls.filter(
        (c) => c.name === 'agent_create' && c.args['name'] === 'architect-reviewer'
      )
    ).toHaveLength(0);
  });

  it('update:false leaves existing personas untouched', async () => {
    const client = new FakeAgentMcpCaller(new Set(['architect-reviewer', 'api-designer']));
    const result = await importClaudeAgents(dir, client, { update: false });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(client.calls.filter((c) => c.name === 'agent_update')).toHaveLength(0);
    expect(client.calls.filter((c) => c.name === 'agent_create')).toHaveLength(0);
  });
});
