/**
 * @adhd/apigen-plugin-py-grpc — Python gRPC target for apigen.
 *
 * Serves a Python `.py` module over real gRPC via a TWO-PHASE spawn
 * (apigen-serve-core `py-grpc-serve-split`, mirroring `py-flask-serve-
 * split`'s pattern almost mechanically — see
 * `docs/apigen/proposals/py-extract-serve-split-findings.md` §2.1):
 *
 *   1. Spawn `python3 -m apigen_python.extractor --emit-json` (short-lived,
 *      extract-only) and parse its stdout into `Operation[]`.
 *   2. Call the REAL `@adhd/apigen-engine-naming` `project(op)` on each op —
 *      the SAME canonical projector `api-fastify`/`api-express`/`mcp`/`cli`
 *      all derive their names from — to compute `{package, service, method}`
 *      per op via `project(op).grpc`.
 *   3. Serialize `{operations, grpc}` to a temp JSON file and spawn
 *      `python3 -m apigen_python.grpc_server ... --plan-file <path>`; the
 *      Python server builds its service/method table from this INJECTED
 *      plan instead of self-extracting or re-deriving package/service/method.
 *
 * Service contract (`@adhd/apigen-engine-naming`'s `project(op).grpc` — the
 * SAME derivation every other transport uses; py-grpc previously carried an
 * unrelated inline naming scheme, deleted by this split — see
 * `grpc_server.py`'s module docstring):
 *   package  = dotted, snake_cased, every `[namespace, ...path]` segment but
 *              the last (e.g. `pkg.grpc_api`)
 *   service  = Pascal-cased second-to-last segment — the "file" segment
 *              (e.g. `GrpcApi`)
 *   method   = Pascal-cased last segment — the "export" segment
 *              (e.g. `AddDecimal`)
 *   methods  = /<package>.<Service>/<Method>
 *
 * Wire contract (canonical apigen tenet):
 *   Request:  message { <Method>Request.Data data = 1; }
 *             Data has typed fields from the JSON-Schema input descriptor.
 *   Response: message { string data = 1; }  (JSON-encoded result)
 *
 *   date-time  → string (RFC3339)   — NOT protobuf Timestamp
 *   decimal    → string (decimal string)
 *   integer    → int64
 *   number     → double
 *   boolean    → bool
 *
 * `--plan-file` wire format: a temp JSON FILE (`fs.mkdtemp` + `--plan-file
 * <path>`), not a `--plan '<json>'` argv string — same ARG_MAX / shell-
 * quoting rationale as `py-flask`'s plugin.ts (see that file's module
 * docstring).
 *
 * Unlike the TS-extraction plugins (api-fastify/api-express/mcp), this
 * plugin still never sees an `Operation[]` on `RunInput` — `RunInput.operations`
 * is absent for non-TS-extraction run paths (the CLI's `run` command routes
 * `.py` sources straight to `plugin.run()` with an empty `schemas: {}`
 * package stub). Instead, THIS plugin obtains `Operation[]` itself via
 * phase 1 above.
 *
 * Readiness: the Python server emits `{"ready":true}` on stdout once it
 * is accepting connections.  This plugin waits for that line (bounded to
 * 10 s) before resolving, so downstream tools know the server is ready.
 *
 * Reflection: grpc_reflection v1alpha is enabled unconditionally, so
 * grpcurl can call methods without a local .proto file:
 *
 *   grpcurl -plaintext \\
 *     -d '{"data":{"amount":"123.456"}}' \\
 *     localhost:50051 pkg.grpc_api.GrpcApi/AddDecimal
 *
 * Usage:
 *   apigen run --source my_api.py --type py-grpc --opt port=50051 --opt namespace=myapi
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Operation, OutputPlugin, RunInput } from '@adhd/apigen-core-client';
import { ensurePythonEnv } from '@adhd/apigen-python-env';
import { project } from '@adhd/apigen-engine-naming';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Python package dir + interpreter resolution now lives in
// @adhd/apigen-python-env (ensurePythonEnv) — the interpreter is a managed
// venv provisioned from apigen-python's own pyproject.toml, so the spawned
// server never depends on the ambient PATH python having grpcio installed.

/**
 * Wait until the Python subprocess emits `{"ready":true}` on stdout
 * or the process exits (failure), bounded by `timeoutMs`.
 *
 * @param proc       - The spawned child process.
 * @param timeoutMs  - Maximum milliseconds to wait (default 10 000).
 * @returns           Resolves when ready; rejects on timeout or early exit.
 */
function waitForReady(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    let settled = false;

    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error('py-grpc: timed out waiting for {"ready":true}'))
      );
    }, timeoutMs);

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        if (msg['ready'] === true) {
          settle(() => resolve());
        }
      } catch {
        // Not JSON — ignore; the server may log non-JSON lines
      }
    });

    proc.on('exit', (code) => {
      settle(() =>
        reject(
          new Error(`py-grpc: python process exited prematurely (code ${code})`)
        )
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Phase 1 — spawn `apigen_python.extractor --emit-json` (short-lived,
// extract-only) and parse its stdout into Operation[].
//
// [dupe-flag] This is a byte-for-byte duplicate of py-flask's plugin.ts
// `runExtractorEmitJson` (read-only reference for this state — see this
// package's task reservations). A shared `@adhd/apigen-python-env` (or a new
// small helper package) home for this function is the correct DRY fix per
// AGENTS.md §8's "Two-Use Refactor Rule" now that a second caller exists,
// but py-flask's plugin.ts is READ-ONLY for this state, so it cannot be
// refactored to import a shared helper here without violating that
// reservation — reported to the orchestrator as a follow-up rather than
// done inline.
// ---------------------------------------------------------------------------

function runExtractorEmitJson(
  pyenv: ReturnType<typeof ensurePythonEnv>,
  modulePath: string,
  namespace: string
): Promise<Operation[]> {
  return new Promise<Operation[]>((resolve, reject) => {
    const proc = spawn(
      pyenv.python,
      [
        '-m',
        'apigen_python.extractor',
        modulePath,
        '--namespace',
        namespace,
        '--emit-json',
      ],
      {
        cwd: pyenv.pythonPkgDir,
        env: { ...process.env, PYTHONPATH: pyenv.pythonPkgDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `py-grpc: extractor --emit-json exited with code ${code}:\n${stderr}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Operation[]);
      } catch (err) {
        reject(
          new Error(
            `py-grpc: extractor --emit-json produced invalid JSON (${
              (err as Error).message
            }):\n${stdout}`
          )
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// run() — two-phase spawn: extract-only, then project(), then serve.
// ---------------------------------------------------------------------------

/**
 * One entry of the `--plan-file` payload's `grpc` map — TS-computed via the
 * real `project(op).grpc`, never re-derived Python-side.
 */
interface ServePlanGrpc {
  package: string;
  service: string;
  method: string;
}

/** The `--plan-file` JSON payload `grpc_server.py`'s `_build_state()` consumes. */
interface ServePlan {
  operations: Operation[];
  grpc: Record<string, ServePlanGrpc>;
}

async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number | string | undefined) ?? 50051;
  const host = (input.options['host'] as string | undefined) ?? '127.0.0.1';

  // Determine the source file and namespace from RunInput.
  // Convention: packages[0].id is the namespace; importPath is the .py file.
  const pkg = input.packages[0];
  if (!pkg) {
    throw new Error('py-grpc plugin: no package in RunInput.packages');
  }

  const namespace =
    (input.options['namespace'] as string | undefined) ?? pkg.id;
  const modulePath = pkg.importPath;

  if (!modulePath.endsWith('.py')) {
    throw new Error(
      `py-grpc plugin: --source must point to a .py file, got: ${modulePath}`
    );
  }

  // Provision (or reuse) the managed interpreter — deps come from
  // apigen-python's own pyproject.toml, never the ambient PATH python.
  const pyenv = ensurePythonEnv({ extras: ['grpc'] });

  // ---- Phase 1: extract-only subprocess -> Operation[] ----
  const operations = await runExtractorEmitJson(pyenv, modulePath, namespace);

  // ---- Phase 2: canonical package/service/method via the REAL project()
  // (never a Python re-derivation — see grpc_server.py's module docstring) ----
  const grpcMap: Record<string, ServePlanGrpc> = {};
  for (const op of operations) {
    const projected = project(op);
    grpcMap[op.id] = {
      package: projected.grpc.package,
      service: projected.grpc.service,
      method: projected.grpc.method,
    };
  }
  const plan: ServePlan = { operations, grpc: grpcMap };

  // ---- Phase 3: write the plan to a temp file and spawn grpc_server ----
  // See module docstring for why a temp FILE, not a `--plan '<json>'` argv
  // string, was chosen (ARG_MAX + shell-quoting risk).
  const planDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'apigen-py-grpc-plan-')
  );
  const planPath = path.join(planDir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan));

  const cleanupPlan = (): void => {
    fs.rmSync(planDir, { recursive: true, force: true });
  };

  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(
      pyenv.python,
      [
        '-m',
        'apigen_python.grpc_server',
        '--module',
        modulePath,
        '--namespace',
        namespace,
        '--host',
        String(host),
        '--port',
        String(port),
        '--plan-file',
        planPath,
      ],
      {
        cwd: pyenv.pythonPkgDir,
        env: { ...process.env, PYTHONPATH: pyenv.pythonPkgDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ) as ChildProcessWithoutNullStreams;
  } catch (err) {
    cleanupPlan();
    throw err;
  }

  // Forward stderr from the Python process to our own stderr so the user
  // sees service/method logs.
  proc.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  // Wait for the readiness signal before resolving — ensures callers (the CLI,
  // tests, the gateway) can start sending requests immediately. Only once
  // the server has bound its port (and therefore already read --plan-file
  // during _build_state()) is it safe to clean up the temp plan file.
  try {
    await waitForReady(proc);
  } finally {
    cleanupPlan();
  }

  // Block until the signal fires (SIGINT/SIGTERM → controller.abort())
  // or the process exits unexpectedly.
  return new Promise<void>((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`py-grpc: python process exited with code ${code}`));
      }
    });

    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        // Resolve ONLY via the `exit` listener above, once the process has
        // actually died — a bare `resolve()` here settled the promise the
        // instant the SIGTERM was sent, before the process (which may
        // ignore SIGTERM) had actually exited, letting it outlive the
        // caller and leak (BUG-APIGEN-TEST-SUBPROCESS-TEARDOWN-LEAK-001).
        // Escalate to SIGKILL if it hasn't exited within the grace period.
        let exited = false;
        proc.once('exit', () => {
          exited = true;
        });
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!exited) {
            proc.kill('SIGKILL');
          }
        }, 3000).unref();
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const pyGrpcPlugin: OutputPlugin = {
  id: 'py-grpc',
  description:
    'Serve Python functions over gRPC (grpcio; in-memory descriptors; reflection enabled)',
  language: 'py',
  optionsSchema: {
    type: 'object',
    properties: {
      port: { type: 'number', default: 50051 },
      host: { type: 'string', default: '127.0.0.1' },
      namespace: { type: 'string' },
    },
  },
  generate(_input) {
    // py-grpc is a run-only plugin; no static codegen output.
    return { files: [] };
  },
  run,
};

export default pyGrpcPlugin;
