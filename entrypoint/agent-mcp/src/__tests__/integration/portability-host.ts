/**
 * portability-host.ts — shared fixture for the 48dc agent-portability e2e
 * (`agent-portability.e2e.test.ts`, `agent-portability-live.e2e.test.ts`).
 *
 * Starts the REAL, BUILT agent-mcp (`dist/src/index.js`) as a child process and
 * connects a REAL MCP client over stdio JSON-RPC — exactly what a host does —
 * with the server's OWN cwd in a neutral directory outside the repo, and with
 * `node_modules/.bin` stripped from PATH (so `srt` discovery is the server's
 * job, not the test runner's). The only scripted component is the LLM boundary:
 * a local OpenAI-compatible HTTP endpoint (`FakeLlm`).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = fileURLToPath(new URL('.', import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, '..', '..', '..');
export const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'src', 'index.js');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** One scripted model turn: a batch of tool calls (`server__tool`). */
export interface ScriptedCall {
  server: 'fs' | 'shell';
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A deterministic OpenAI-compatible `/v1/chat/completions` endpoint. A task is
 * routed to its script by a `CASE:<id>` marker in the prompt; turn N of a case
 * is `script[N]` (N = number of assistant tool-call messages already in the
 * request), then a plain-text "finished" completion. Every `tool` message the
 * agent loop feeds back is recorded per case so the test can assert what the
 * REAL fs/shell servers returned.
 */
export class FakeLlm {
  private server?: http.Server;
  private readonly scripts = new Map<string, ScriptedCall[][]>();
  private readonly toolResults = new Map<string, string[]>();
  baseURL = '';

  setScript(caseId: string, turns: ScriptedCall[][]): void {
    this.scripts.set(caseId, turns);
    this.toolResults.delete(caseId);
  }

  /** Every tool-result string the agent loop fed back for `caseId` (in order). */
  resultsFor(caseId: string): string[] {
    return this.toolResults.get(caseId) ?? [];
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            messages: Array<{
              role: string;
              content?: unknown;
              tool_calls?: unknown[];
            }>;
          };
          const first = body.messages.find((m) => m.role === 'user');
          const caseId =
            /CASE:(\S+)/.exec(String(first?.content ?? ''))?.[1] ?? 'unknown';
          const turn = body.messages.filter(
            (m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0
          ).length;
          this.toolResults.set(
            caseId,
            body.messages
              .filter((m) => m.role === 'tool')
              .map((m) => String(m.content))
          );
          const calls = this.scripts.get(caseId)?.[turn];
          const message = calls
            ? {
                role: 'assistant',
                content: null,
                tool_calls: calls.map((c, i) => ({
                  id: `call_${turn}_${i}`,
                  type: 'function',
                  function: {
                    name: `${c.server}__${c.tool}`,
                    arguments: JSON.stringify(c.args),
                  },
                })),
              }
            : { role: 'assistant', content: 'finished' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-fake',
              object: 'chat.completion',
              created: 0,
              model: 'fake',
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: calls ? 'tool_calls' : 'stop',
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          );
        } catch (err) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseURL = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

/** PATH with every `node_modules/.bin` entry removed (so `srt` is NOT ambient). */
export function pathWithoutNodeBins(pathValue = process.env['PATH'] ?? ''): string {
  return pathValue
    .split(delimiter)
    .filter((p) => p && !p.includes(`${path.sep}node_modules${path.sep}.bin`))
    .join(delimiter);
}

/** True when `srt` is resolvable on `pathValue` (a loud precondition probe). */
export function srtOnPath(pathValue: string): boolean {
  return (
    spawnSync('sh', ['-c', 'command -v srt'], { env: { PATH: pathValue } }).status === 0
  );
}

export interface PortabilityHostOptions {
  /** Neutral directory the SERVER process runs in (outside the repo). */
  serverCwd: string;
  /** Scratch dir for the DB + srt policy file. */
  scratch: string;
  /** Extra env for the server (e.g. the global allowed-root map). */
  env?: Record<string, string>;
  /** Keep ambient ADHD_AGENT_* (the live leg needs the DeepSeek secret). */
  keepAmbientAgentEnv?: boolean;
  /**
   * Server entry script. Defaults to the in-repo built `dist/src/index.js`; the
   * consumer-install e2e (94125709) points it at the installed package's bin.
   */
  entry?: string;
}

export interface PortabilityHost {
  client: Client;
  /** The per-run srt policy file the server was pinned to. */
  srtSettingsPath: string;
  path: string;
  callJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Launch the built server + a real MCP client (stdio JSON-RPC). */
export async function startPortabilityHost(
  opts: PortabilityHostOptions
): Promise<PortabilityHost> {
  const entry = opts.entry ?? DIST_ENTRY;
  if (!fs.existsSync(entry)) {
    throw new Error(`built entry missing at ${entry} — run "npx nx run agent-mcp:build"`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('ADHD_AGENT_') && !opts.keepAmbientAgentEnv) continue;
    env[k] = v;
  }
  const srtSettingsPath = path.join(opts.scratch, 'srt-run-policy.json');
  const hostPath = pathWithoutNodeBins();
  Object.assign(env, {
    PATH: hostPath,
    ADHD_AGENT_DATABASE_PATH: path.join(opts.scratch, 'agents.db'),
    ADHD_AGENT_REGISTRY_DB_PATH: path.join(opts.scratch, 'registry.db'),
    ADHD_AGENT_TRANSPORT: 'stdio',
    ADHD_AGENT_SSE_ENABLED: 'false',
    ADHD_AGENT_SRT_SETTINGS: srtSettingsPath,
    ...(opts.env ?? {}),
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
    cwd: opts.serverCwd,
  });
  const client = new Client({ name: 'portability-48dc', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const callJson = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 300_000,
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = res.content?.map((c) => c.text ?? '').join('') ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { _raw: text };
    }
    if (res.isError) parsed['_isError'] = true;
    return parsed;
  };

  return {
    client,
    srtSettingsPath,
    path: hostPath,
    callJson,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}
