#!/usr/bin/env node
// flat-content-mcp-entry.js — real subprocess entry point for the ADR-0004
// default-running guard (`flat-content-payload.spec.ts`).
//
// Deliberately plain CommonJS (no TypeScript) so it can be `node`-spawned
// directly by `StdioClientTransport` (which always spawns a child process —
// there is no in-process stdio MCP test possible, since the server side would
// fight the test runner's own stdio channel).
//
// It requires the BUILT `dist/index.js` and calls the built `mcpPlugin.run()`
// — a real consumer path, never a bypass of the host wiring / dist dependency
// resolution. `apigen-plugin-mcp:test` dependsOn `build` so this artifact is
// always fresh.
'use strict';
const path = require('node:path');

// The SDK's default child env is a narrow allowlist; keep the child calm.
process.env.VITEST = 'true';

const distEntry = path.join(__dirname, '..', '..', '..', 'dist', 'index.js');
const { mcpPlugin } = require(distEntry);

// `outputDir` is a REQUIRED field of `PluginInput`/`RunInput`
// (`@adhd/apigen-core-client` types.ts: `outputDir: string`), but the MCP
// plugin's `run()` never reads it — it writes no files on any transport (the
// stdio path is pure JSON-RPC on stdout/stdin; sse/streaming-http only bind a
// socket). Keep it pointing at this repo's ephemeral scratch root
// (`tmp/<package>/…`, gitignored — AGENTS.md §10) rather than a hardcoded
// system `/tmp/out` path; the value is inert either way.
const workspaceRoot = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..'
);
const outputDir = path.join(workspaceRoot, 'tmp', 'apigen-plugin-mcp');

// Silent logger: the run() path would otherwise emit tool-registration lines
// on stderr. stdout is the JSON-RPC channel either way.
const noop = () => undefined;
const silentLogger = {
  info: noop,
  error: noop,
  warn: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child() {
    return silentLogger;
  },
};

// A discriminated-union return type — NOT a top-level `type:'object'`, so
// ADR-0004 requires the adapter to advertise no `outputSchema` and emit no
// `structuredContent` for it.
const unionOutput = {
  oneOf: [
    {
      type: 'object',
      properties: { outcome: { const: 'found' }, hits: { type: 'array' } },
      required: ['outcome', 'hits'],
    },
    {
      type: 'object',
      properties: { outcome: { const: 'empty' } },
      required: ['outcome'],
    },
  ],
  discriminator: { propertyName: 'outcome' },
  'x-apigen-logical': 'union',
};

const schemas = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['data'],
    },
    output: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
  },
  search: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    output: unionOutput,
  },
};

const fns = {
  getUser: (userId) => ({ id: userId, name: `User-${userId}` }),
  search: () => ({ outcome: 'found', hits: ['result-1'] }),
};

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

mcpPlugin
  .run({
    packages: [
      {
        id: 'flat-content-pkg',
        schemas,
        importPath: '@test/flat-content-pkg',
        fns,
      },
    ],
    outputDir,
    options: { transport: 'stdio' },
    logger: silentLogger,
    signal: controller.signal,
  })
  .catch((err) => {
    process.stderr.write(
      `flat-content-mcp-entry: mcpPlugin.run failed: ${
        err && err.stack ? err.stack : String(err)
      }\n`
    );
    process.exit(1);
  });
