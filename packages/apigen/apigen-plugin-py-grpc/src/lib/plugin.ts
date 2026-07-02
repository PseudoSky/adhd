/**
 * @adhd/apigen-plugin-py-grpc — Python gRPC target for apigen.
 *
 * Serves a Python `.py` module over real gRPC by spawning
 * `python3 -m apigen_python.grpc_server` as a subprocess.
 *
 * Service contract:
 *   package  = <namespace>
 *   service  = <Namespace>Service  (e.g. pkg → PkgService)
 *   methods  = /<namespace>.<Namespace>Service/<fn_name>
 *
 * Wire contract (canonical apigen tenet):
 *   Request:  message { <Namespace>Request.Data data = 1; }
 *             Data has typed fields from the JSON-Schema input descriptor.
 *   Response: message { string data = 1; }  (JSON-encoded result)
 *
 *   date-time  → string (RFC3339)   — NOT protobuf Timestamp
 *   decimal    → string (decimal string)
 *   integer    → int64
 *   number     → double
 *   boolean    → bool
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
 *     localhost:8950 pkg.PkgService/add_decimal
 *
 * Usage:
 *   apigen run --source my_api.py --type py-grpc --opt port=8950 --opt namespace=myapi
 */

import * as readline from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { OutputPlugin, RunInput } from '@adhd/apigen-core';
import { ensurePythonEnv } from '@adhd/apigen-python-env';

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
// run() — spawn the Python gRPC server
// ---------------------------------------------------------------------------

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

  const proc = spawn(
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
    ],
    {
      cwd: pyenv.pythonPkgDir,
      env: { ...process.env, PYTHONPATH: pyenv.pythonPkgDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  ) as ChildProcessWithoutNullStreams;

  // Forward stderr from the Python process to our own stderr so the user
  // sees service/method logs.
  proc.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  // Wait for the readiness signal before resolving — ensures callers (the CLI,
  // tests, the gateway) can start sending requests immediately.
  await waitForReady(proc);

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
        proc.kill('SIGTERM');
        resolve();
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
