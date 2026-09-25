/**
 * Generated-host lifecycle (b7bb606d) — real child-process exit proof.
 *
 * The structural assertions in `emit-injection.spec.ts` only read the emitted
 * text. This spec proves the CONSUMER-VISIBLE outcome the fix exists for: the
 * generated `routes.ts`, compiled by esbuild and run as a real Node process
 * against a port that is ALREADY bound, exits NON-ZERO within a bounded
 * deadline — through its own controlled failure path, not an
 * unhandled-rejection crash.
 *
 * Teeth: the pre-fix output (`app.listen({ port })` as a bare floating promise)
 * also happens to exit non-zero on Node >= 15 because the rejected promise is
 * unhandled — but it dumps an `EADDRINUSE` stack to stderr. The fix catches the
 * failure and calls `process.exit(1)` with no crash trace. So the test keys on
 * the EXIT CODE (primary) and additionally asserts the crash marker is absent;
 * reverting the fix turns the stderr assertion red. Both were verified by hand
 * against the two emitted shapes before committing.
 *
 * Real components only: esbuild compiles the ACTUAL `generate()` output and the
 * child runs the ACTUAL compiled file against real `fastify`. The workspace
 * runtime and the user package the generated file imports are stubbed — they
 * are boundaries outside the behaviour under test (the host lifecycle);
 * `fastify`, whose `listen` produces the bind failure, is real.
 */
import { describe, it, expect } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generate } from '../lib/generate';
import type { PluginInput } from '@adhd/apigen-core-client';

// `<worktree>/packages/apigen/apigen-plugin-api-fastify/src/test` → worktree root.
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'apigen');

/** A TCP server bound (and left listening) on an OS-assigned 127.0.0.1 port. */
async function bindBlockerPort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Runs a compiled file, resolving on exit; kills + rejects past `deadlineMs`. */
function runChild(
  scriptPath: string,
  deadlineMs: number
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `generated host did not exit within ${deadlineMs}ms ` +
            `(stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)})`
        )
      );
    }, deadlineMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

describe('generated host lifecycle (b7bb606d) — real child process', () => {
  it(
    '[lifecycle-child.1] exits non-zero within a bounded deadline on an already-bound port, without an unhandled-rejection crash',
    async () => {
      const blocker = await bindBlockerPort();
      fs.mkdirSync(TMP_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'fastify-lifecycle-'));
      try {
        // A minimal, resolvable generated host. The user package + workspace
        // runtime are stubbed (see the file header); `fastify` stays real.
        const input: PluginInput = {
          packages: [
            {
              id: 'pkg-a',
              importPath: './pkg-stub',
              schemas: {
                ping: {
                  input: {
                    type: 'object',
                    properties: { data: { type: 'object', properties: {} } },
                    required: ['data'],
                  },
                  output: { type: 'object' },
                },
              },
              fns: { ping: () => ({ ok: true }) },
            },
          ],
          outputDir: dir,
          options: { port: blocker.port },
        };

        fs.writeFileSync(
          path.join(dir, 'pkg-stub.ts'),
          'export function ping(): { ok: boolean } { return { ok: true }; }\n'
        );
        fs.writeFileSync(
          path.join(dir, 'runtime-stub.ts'),
          [
            'export const dispatch = (): unknown => undefined;',
            'export const buildFnTable = (ns: unknown): unknown => ns;',
            'export const coerceQueryParams = (q: unknown): unknown => q;',
            '',
          ].join('\n')
        );
        fs.writeFileSync(
          path.join(dir, 'routes.ts'),
          generate(input).files[0].content
        );

        await esbuild.build({
          entryPoints: [path.join(dir, 'routes.ts')],
          outfile: path.join(dir, 'routes.cjs'),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          // Fastify resolves from the repo's node_modules at runtime (cwd is
          // the repo root) — bundling it would drag in optional/native deps.
          external: ['fastify'],
          absWorkingDir: REPO_ROOT,
          logLevel: 'silent',
          plugins: [
            {
              name: 'stub-apigen-runtime',
              setup(build) {
                build.onResolve(
                  { filter: /^@adhd\/apigen-engine-runtime$/ },
                  () => ({ path: path.join(dir, 'runtime-stub.ts') })
                );
              },
            },
          ],
        });

        const result = await runChild(path.join(dir, 'routes.cjs'), 15000);

        // Primary: it exited on its own (not killed by our deadline) with a
        // failure code.
        expect(result.signal).toBeNull();
        expect(result.code).not.toBeNull();
        expect(result.code).not.toBe(0);

        // Teeth: the fix EXITS through its catch path. The pre-fix bare
        // floating `app.listen(...)` crashed with an unhandled EADDRINUSE
        // rejection — this marker must be absent.
        expect(result.stderr).not.toContain('EADDRINUSE');
        expect(result.stderr).not.toContain('UnhandledPromiseRejection');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        await blocker.close();
      }
    },
    30000
  );
});
