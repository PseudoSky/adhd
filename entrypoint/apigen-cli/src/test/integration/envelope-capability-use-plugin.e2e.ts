// DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001 regression guard.
//
// `EnvelopeCapability` (`apigen-core-client/src/lib/plugin.ts:391-410`) is
// declared on the v2 `Plugin` interface, but until this fix no real
// `--use <plugin>` extraction could ever make a declared envelope field
// (`capabilities.envelope.request`) reach a served operation's schema — every
// existing test that exercised `x-apigen-envelope` hand-built its
// `ComposedSchemas` directly (`apigen-plugin-cli-output/src/test/run.spec.ts`'s
// `whoAmI` fixture; that package's own `run-cli-integration.spec.ts` parity
// harness, whose header comment documents this exact gap). This spec is the
// first test in the repo that drives a REAL `--use <plugin>` through the REAL
// orchestrator + a REAL HTTP transport (api-fastify) end to end.
//
// What is proven:
//   (1) A `--use` plugin combining `envelope` (declares the `session` field)
//       and `layer` (reads `call.envelope.session` and echoes it onto the
//       result) — the exact pattern `EnvelopeCapability`'s own doc comment
//       describes — actually surfaces the header-supplied value in the
//       consumer-visible HTTP response body. Pre-fix, `composeSchemas()` was
//       always called with `middlewares: []` (orchestrator.ts), so
//       `plan.envelope` was always `[]`, `readCall` never populated
//       `call.envelope`, and this assertion would see `session: undefined`
//       regardless of what header the client sent — TEETH.
//   (2) The field is bound at `x-<pluginId>-<field>` (`x-auth-session`), using
//       the LOADED plugin's own `id` as the pluginId — not a hardcoded
//       default — proving the `x-apigen-envelope` pluginId stamp
//       (`compose-schemas.ts`) is wired from the real plugin object.
//   (3) The merged field is REQUIRED: a request omitting the header is
//       rejected `400 invalid_argument` by the validate-Layer BEFORE the
//       domain function or the layer ever runs — proving the merge lands on
//       the schema `composeSchemas()` produces, not just on some side
//       channel the layer reads independently.
//
// Real-consumer protocol (CLAUDE.md §7 "Proving an MCP server works" / real
// end-to-end test protocol used elsewhere in this suite): the BUILT CLI bin
// is spawned as a real child process and driven with real `fetch()` HTTP
// requests — never an in-process function call, never a mock transport.
//
// Live: runs BY DEFAULT, unflagged. A local spawned process is not a paid
// third-party service (CLAUDE.md §6) — no env gating.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { project, envelopeKey } from '@adhd/apigen-engine-naming';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BUILT_BIN = path.join(
  REPO_ROOT,
  'entrypoint',
  'apigen-cli',
  'dist',
  'index.js'
);

const NAMESPACE = 'envelope-harness';
const FN_NAME = 'whoAmI';
const PLUGIN_ID = 'auth';

const TS_FIXTURE = `
export function whoAmI(): { ok: boolean } {
  return { ok: true };
}
`.trim();

/**
 * A minimal, self-contained ESM `--use` plugin (loaded via `loadUsePlugins()`'s
 * local-path branch — a real dynamic `import()`, not a test-only bypass).
 * Combines `envelope` (declares the `session` field this plugin reads from
 * transport metadata) with `layer` (reads it off `call.envelope` and echoes it
 * onto the result) — exactly the pattern `EnvelopeCapability`'s own doc
 * comment describes ("A plugin may combine `envelope` with `layer` to both
 * *declare* the fields it needs and *read/write* them").
 */
const SESSION_PLUGIN = `
export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  capabilities: {
    envelope: {
      request: { session: { type: 'string' } },
    },
    layer: {
      layer: async (call, next) => {
        const result = await next();
        if (result && typeof result === 'object') {
          return Object.assign({}, result, { session: call.envelope.session });
        }
        return result;
      },
    },
  },
};
`.trim();

// ---------------------------------------------------------------------------
// Canonical route/verb — derived from the same `project()` authority every
// transport uses, never hand-guessed (matches the convention established by
// `real-consumer.spec.ts` / `cross-host-response-envelope.spec.ts`).
// ---------------------------------------------------------------------------

function seg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

function buildOp(namespaceRaw: string, fileRaw: string, fnRaw: string): Operation {
  const namespace = seg(namespaceRaw);
  const opPath = [seg(fileRaw), seg(fnRaw)];
  return {
    id: [namespace, ...opPath].map((s) => s.words.join('-')).join('/'),
    host: 'ts',
    namespace,
    path: opPath,
    kind: 'action',
    async: false,
    streaming: false,
    safe: true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}

const { http } = project(
  buildOp(NAMESPACE, 'envelope-fixture', FN_NAME)
);
const SESSION_HEADER = envelopeKey(PLUGIN_ID, 'session');

/** Allocate a free TCP port via the OS (listen-then-close). */
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

/** Bounded readiness poll — no fixed sleep. */
async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: http.verb,
        headers: { [SESSION_HEADER]: 'probe' },
      });
      await res.text().catch(() => undefined);
      return;
    } catch {
      // not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error(`api-fastify server did not become ready at ${url}`);
}

let child: ChildProcess | undefined;
let tmpDir: string | undefined;

afterEach(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  child = undefined;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('[envelope-capability] DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001', () => {
  it(
    'a --use plugin declaring EnvelopeCapability surfaces its field through a real HTTP transport',
    { timeout: 60_000 },
    async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-envelope-'));
      const fixtureFile = path.join(tmpDir, 'envelope-fixture.ts');
      const pluginFile = path.join(tmpDir, 'session-plugin.mjs');
      fs.writeFileSync(fixtureFile, TS_FIXTURE);
      fs.writeFileSync(pluginFile, SESSION_PLUGIN);

      const port = await freePort();
      child = spawn(
        'node',
        [
          BUILT_BIN,
          'run',
          '--source',
          fixtureFile,
          '--type',
          'api-fastify',
          '--namespace',
          NAMESPACE,
          '--opt',
          `port=${port}`,
          '--use',
          pluginFile,
        ],
        { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
      );

      const url = `http://127.0.0.1:${port}${http.route}`;
      await waitForReady(url);

      // ── (1) + (2): the header-supplied session value must surface in the
      // response body, bound at the plugin's OWN id (`x-auth-session`) — the
      // exact assertion that only passes once EnvelopeCapability is wired end
      // to end (pre-fix: `call.envelope` was always `{}`, so `session` would
      // be `undefined` here regardless of the header). ────────────────────
      const res = await fetch(url, {
        method: http.verb,
        headers: { [SESSION_HEADER]: 'tok-abc123' },
      });
      expect(res.status, 'GET with session header must succeed').toBe(200);
      const body = (await res.json()) as { ok: boolean; session: string };
      expect(body.ok).toBe(true);
      expect(
        body.session,
        'the session envelope value must round-trip through the real --use plugin + real HTTP transport'
      ).toBe('tok-abc123');

      // ── (3): the merged field is REQUIRED — a request omitting the header
      // must be rejected by the validate-Layer, proving the merge landed on
      // the actual composed SCHEMA (not merely readable by the layer). ────
      const rejected = await fetch(url, { method: http.verb });
      expect(
        rejected.status,
        'a request missing the required session envelope field must be rejected, not silently accepted'
      ).toBe(400);
      const errBody = (await rejected.json()) as { code?: string };
      expect(errBody.code).toBe('invalid_argument');
    }
  );
});
