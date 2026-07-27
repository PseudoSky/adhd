// CAPSTONE real-consumer proof (dod.19).
//
// Runs the BUILT apigen-cli bin (`dist/packages/apigen/cli/index.js`) against an
// UNMODIFIED real package — `@adhd/transform`'s `src/lib/text.ts`, whose source
// is NEVER edited — to stand up a real server, then drives it with a REAL client:
//
//   - MCP variant:  a real `@modelcontextprotocol/sdk` Client over stdio connects
//                   to the built bin (`run --source … --type mcp`). `tools/list`
//                   must equal transform's exported function names (derived by
//                   importing the module in-process), and each `callTool` must
//                   deep-equal calling that export DIRECTLY in-process.
//   - HTTP variant: the built bin (`run --source … --type api-fastify`) serves
//                   the same exports over real HTTP; `POST /<id>/<fn>` results
//                   deep-equal the in-process ground truth.
//
// Negative control: the expected tool/route set is DERIVED from the package's
// real exports. If a mapping renamed or dropped an export, the derived set would
// diverge from the package's exports → the equality assertions go red.
//
// Live variant (APIGEN_LIVE=1): a REAL model drives the MCP loop and we assert
// model-INDEPENDENT invariants (the tool it lists/calls exists + returns the
// ground truth). Gated so CI stays offline + deterministic.
//
// Determinism (CLAUDE.md §6): readiness is a bounded poll, never a sleep. Every
// spawned server (stdio child via the MCP transport; HTTP child process) is
// ALWAYS killed in teardown (no orphans). Ground truth is computed by importing
// the SAME unmodified module the bin extracts.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import {
  READY_TIMEOUT_MS,
  liveTestTimeoutMs,
  captureStderr,
} from '../support/readiness';

// DEBT-APIGEN-CLI-STALE-ROUTE-TOOL-NAME-ASSERTIONS-001: since BUG-APIGEN-
// OPENAPI-ROUTE-PATH-MISMATCH-001, every transport derives its operation
// identifiers from the single shared authority, `@adhd/apigen-engine-naming`'s
// `project(op)` — never the raw exported fn name. Compute the expected
// canonical MCP tool name / HTTP route from the SAME `project()` call
// (rather than a hand-guessed literal) for `TRANSFORM_SRC`'s
// namespace ("data-base-transforms") + file ("text") + each export.
function seg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}
function buildOp(exportName: string): Operation {
  const namespace = seg('data-base-transforms');
  const path = [seg('text'), seg(exportName)];
  return {
    id: [namespace, ...path].map((s) => s.words.join('-')).join('/'),
    host: 'ts',
    namespace,
    path,
    kind: 'action',
    async: true,
    streaming: false,
    safe: true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}
/** The canonical `project(op).mcp.name` for a raw `text.ts` export name. */
function canonicalToolName(exportName: string): string {
  return project(buildOp(exportName)).mcp.name;
}
/** The canonical `project(op).http.route` (namespace-relative, no leading `/`). */
function canonicalHttpPath(exportName: string): string {
  // `.http.route` is `/` + namespace + path — strip the leading `/namespace/`
  // since the call sites below build `${namespace}/${fnPath}` themselves.
  const route = project(buildOp(exportName)).http.route;
  return route.split('/').slice(2).join('/');
}

/** Bind a TCP server to port 0, record the OS-assigned port, close it, return that port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Paths — the BUILT bin + the UNMODIFIED real package source.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BUILT_BIN = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'dist',
  'index.js'
);
// An UNMODIFIED file from the real @adhd/data-base-transforms package (flat function exports).
const TRANSFORM_SRC = path.join(
  REPO_ROOT,
  'packages',
  'data',
  'data-base-transforms',
  'src',
  'lib',
  'text.ts'
);

// ---------------------------------------------------------------------------
// In-process ground truth — import the SAME module the bin extracts.
// ---------------------------------------------------------------------------

// The argument map the consumer probe sends (and spreads positionally in-process).
// Keys are transform's exported fn names. Only a representative subset is exercised
// with non-trivial args; the FULL exported set is what tools/list is checked against.
const SAMPLE_ARGS: Record<string, unknown[]> = {
  upperFirst: ['hello'],
  lowerFirst: ['HELLO'],
  capitalize: ['hELLO world'],
  toUpper: ['abc'],
  toLower: ['ABC'],
  trim: ['  hi  '],
  hyphenCase: ['helloWorld'],
};

interface GroundTruth {
  exportedNames: string[];
  values: Record<string, unknown>;
  mod: Record<string, (...a: unknown[]) => unknown>;
}

let ground: GroundTruth;

beforeAll(async () => {
  // Import the unmodified transform module in-process for ground truth.
  const mod = (await import(TRANSFORM_SRC)) as Record<string, unknown>;
  const fnEntries = Object.entries(mod).filter(
    ([, v]) => typeof v === 'function'
  );
  const exportedNames = fnEntries.map(([k]) => k).sort();
  const fns: Record<string, (...a: unknown[]) => unknown> = {};
  for (const [k, v] of fnEntries) fns[k] = v as (...a: unknown[]) => unknown;
  const values: Record<string, unknown> = {};
  for (const [name, args] of Object.entries(SAMPLE_ARGS)) {
    values[name] = fns[name](...args);
  }
  ground = { exportedNames, values, mod: fns };
}, 30_000);

// ---------------------------------------------------------------------------
// Lifecycle tracking — kill any spawned server in teardown.
// ---------------------------------------------------------------------------

let mcpClient: Client | undefined;
let mcpTransport: StdioClientTransport | undefined;
let httpChild: ChildProcess | undefined;

afterEach(async () => {
  if (mcpClient) {
    await mcpClient.close().catch(() => undefined);
    mcpClient = undefined;
  }
  if (mcpTransport) {
    await mcpTransport.close().catch(() => undefined);
    mcpTransport = undefined;
  }
});

afterAll(async () => {
  if (httpChild && !httpChild.killed) {
    httpChild.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// (1) MCP variant — real MCP client over stdio against the BUILT bin.
// ---------------------------------------------------------------------------

describe('real-consumer: MCP over the built bin against UNMODIFIED @adhd/data-base-transforms', () => {
  it('tools/list == transform exports; callTool deep-equals in-process ground truth', async () => {
    // The MCP SDK stdio client SPAWNS the built bin as the server process and
    // manages its lifecycle (closed in afterEach).
    mcpTransport = new StdioClientTransport({
      command: 'node',
      args: [BUILT_BIN, 'run', '--source', TRANSFORM_SRC, '--type', 'mcp'],
      cwd: REPO_ROOT,
    });
    mcpClient = new Client(
      { name: 'real-consumer-test', version: '1.0.0' },
      { capabilities: {} }
    );
    await mcpClient.connect(mcpTransport);

    // tools/list must equal the package's exported function names, each
    // projected to its canonical MCP tool name (project(op).mcp.name).
    const listed = await mcpClient.listTools();
    const toolNames = listed.tools.map((t) => t.name).sort();
    const expectedToolNames = ground.exportedNames
      .map((n) => canonicalToolName(n))
      .sort();
    expect(toolNames).toEqual(expectedToolNames);
    // Teeth: every sampled export is present (a dropped/renamed export → red).
    for (const name of Object.keys(SAMPLE_ARGS)) {
      expect(toolNames).toContain(canonicalToolName(name));
    }

    // Each callTool deep-equals calling the export directly in-process.
    for (const [name, args] of Object.entries(SAMPLE_ARGS)) {
      // The MCP `data` payload maps named params; text.ts fns take positional
      // (str, c?). We send the first positional as the sole domain arg under the
      // schema's first param name. The dispatch spreads dataParamNames in order.
      const dataArg = buildDataArg(name, args);
      const res = (await mcpClient.callTool({
        name: canonicalToolName(name),
        arguments: { data: dataArg },
      })) as {
        content: Array<{ type: string; text: string }>;
      };
      const text = res.content.find((c) => c.type === 'text')?.text ?? 'null';
      const got = JSON.parse(text);
      expect(
        got,
        `callTool(${name}) must equal in-process ground truth`
      ).toEqual(ground.values[name]);
    }
  }, liveTestTimeoutMs(1));
});

/**
 * Read an HTTP body as its JSON value, falling back to the raw text for bare
 * string returns (Fastify serializes a string return as `text/plain`, an object
 * as `application/json`). Mirrors how the in-process value would be compared.
 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Map positional sample args to the named `data` payload using the in-process
 * function's parameter names. text.ts fns are `(str = '', c = '\\s')` etc., so the
 * first param is the primary input. We introspect the fn's param names via its
 * source string to stay generalized (no per-fn literal).
 */
function buildDataArg(name: string, args: unknown[]): Record<string, unknown> {
  const fn = ground.mod[name];
  const paramNames = fnParamNames(fn);
  const data: Record<string, unknown> = {};
  args.forEach((v, i) => {
    if (paramNames[i]) data[paramNames[i]] = v;
  });
  return data;
}

/** Extract parameter names from a function's source (best-effort, deterministic). */
function fnParamNames(fn: (...a: unknown[]) => unknown): string[] {
  const src = fn.toString();
  const m = /^[^(]*\(([^)]*)\)/.exec(src);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((p) => p.trim().split('=')[0].trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// (2) HTTP variant — real HTTP client against the BUILT bin (api-fastify).
// ---------------------------------------------------------------------------

describe('real-consumer: HTTP over the built bin against UNMODIFIED @adhd/transform', () => {
  it('GET /<id>/<fn> deep-equals in-process ground truth over real HTTP', async () => {
    const port = await freePort();
    httpChild = spawn(
      'node',
      [
        BUILT_BIN,
        'run',
        '--source',
        TRANSFORM_SRC,
        '--type',
        'api-fastify',
        '--opt',
        `port=${port}`,
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const getStderr = captureStderr(httpChild);

    // Bounded readiness poll — no fixed sleep. Fails fast (with the child's
    // stderr) if the process exits before ever becoming ready.
    const namespace = await waitForHttpReady(port, httpChild, getStderr);

    // FEAT-APIGEN-022: every SAMPLE_ARGS fn here (upperFirst/lowerFirst/
    // capitalize/toUpper/toLower/trim/hyphenCase) takes only string-typed
    // params, so all of them now auto-hoist to GET (query-string), not POST.
    for (const [name, args] of Object.entries(SAMPLE_ARGS)) {
      const dataArg = buildDataArg(name, args);
      const query = new URLSearchParams(
        Object.entries(dataArg).map(([k, v]) => [k, String(v)])
      );
      // DEBT-APIGEN-CLI-STALE-ROUTE-TOOL-NAME-ASSERTIONS-001: routes are now
      // kebab-cased per project(op).http.route (BUG-APIGEN-OPENAPI-ROUTE-
      // PATH-MISMATCH-001's api-fastify-side fix), e.g. `upperFirst` →
      // `upper-first`, not the raw camelCase export name.
      const res = await fetch(
        `http://127.0.0.1:${port}/${namespace}/${canonicalHttpPath(name)}?${query.toString()}`,
        { method: 'GET' }
      );
      expect(res.status, `GET ${name} status`).toBe(200);
      const got = await readBody(res);
      expect(got, `HTTP ${name} must equal in-process ground truth`).toEqual(
        ground.values[name]
      );
    }
  }, liveTestTimeoutMs(1));

  /**
   * Poll the server until a known route answers; returns the package namespace
   * the bin derived (the source's folder name), discovered by probing candidates.
   *
   * Bounded to `READY_TIMEOUT_MS` (default 60 s, overridable via
   * `APIGEN_TEST_READY_TIMEOUT_MS`) — generous enough to survive CPU/port
   * contention under a massively-parallel release run, while still bounded.
   * Fails fast (with the child's captured stderr) if `child` exits before the
   * server ever becomes ready, instead of silently burning the full deadline
   * polling a dead process.
   */
  async function waitForHttpReady(
    p: number,
    child?: ChildProcess,
    getStderr?: () => string
  ): Promise<string> {
    // The namespace is derived from the source's tsconfig/folder. Probe the most
    // likely candidate ('lib' — the parent folder of text.ts) plus a fallback by
    // attempting a real call and accepting the first that yields a 200.
    const candidates = ['data-base-transforms', 'lib', 'text'];
    const deadline = Date.now() + READY_TIMEOUT_MS;
    // DEBT-APIGEN-CLI-STALE-ROUTE-TOOL-NAME-ASSERTIONS-001: the readiness
    // probe must hit the SAME kebab-cased route the fixed api-fastify plugin
    // now serves (`upper-first`, not `upperFirst`).
    const probePath = canonicalHttpPath('upperFirst');
    let childExited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child?.once('exit', (code, signal) => {
      childExited = { code, signal };
    });
    while (Date.now() < deadline) {
      if (childExited) {
        const stderr = getStderr?.() ?? '';
        throw new Error(
          `waitForHttpReady: process exited (code=${childExited.code} ` +
            `signal=${childExited.signal}) before port ${p} became ready` +
            (stderr ? ` — stderr:\n${stderr}` : '')
        );
      }
      for (const ns of candidates) {
        try {
          // FEAT-APIGEN-022: upperFirst(str?: string) is a single-string-param
          // fn — auto-hoisted to GET, so the readiness probe must match.
          const res = await fetch(
            `http://127.0.0.1:${p}/${ns}/${probePath}?str=probe`,
            { method: 'GET' }
          );
          if (res.status === 200) {
            // Drain body to free the socket.
            await res.text().catch(() => undefined);
            return ns;
          }
        } catch {
          // not ready yet
        }
      }
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    throw new Error(`api-fastify server on port ${p} did not become ready`);
  }
});

// ---------------------------------------------------------------------------
// (3) Model-independent invariants via a real MCP client (no AI model needed).
// ---------------------------------------------------------------------------

describe('real-consumer: LIVE client drives the MCP loop (model-independent invariants)', () => {
  it('a real MCP client lists + calls a real transform tool; result == in-process ground truth', async () => {
    // Stand up the same MCP server via the built bin.
    const transport = new StdioClientTransport({
      command: 'node',
      args: [BUILT_BIN, 'run', '--source', TRANSFORM_SRC, '--type', 'mcp'],
      cwd: REPO_ROOT,
    });
    const client = new Client(
      { name: 'live-model-test', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      // Model-independent invariant: the live surface exposes the real
      // exports, each projected to its canonical MCP tool name
      // (project(op).mcp.name — DEBT-APIGEN-CLI-STALE-ROUTE-TOOL-NAME-
      // ASSERTIONS-001). Sort both sides — the MCP server returns tools in
      // declaration order, ground.exportedNames is sorted alphabetically.
      const expectedNames = ground.exportedNames
        .map((n) => canonicalToolName(n))
        .sort();
      expect(names.slice().sort()).toEqual(expectedNames);
      // A real model would pick a tool from `names` and call it; we assert the
      // model-INDEPENDENT outcome — calling a listed tool returns the same value
      // as the in-process export. (The model's CHOICE is non-deterministic; the
      // INVARIANT it must satisfy is not.)
      const sample = 'upperFirst';
      const sampleTool = canonicalToolName(sample);
      expect(names).toContain(sampleTool);
      const res = (await client.callTool({
        name: sampleTool,
        arguments: { data: { str: 'live' } },
      })) as { content: Array<{ type: string; text: string }> };
      const got = JSON.parse(
        res.content.find((c) => c.type === 'text')?.text ?? 'null'
      );
      expect(got).toEqual(ground.mod[sample]('live'));
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }, 120_000);
});
