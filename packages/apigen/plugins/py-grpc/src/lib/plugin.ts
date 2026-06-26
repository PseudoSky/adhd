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

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { OutputPlugin, RunInput } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the directory containing the apigen Python package (`apigen_python/`).
 *
 * When running from the compiled source tree (`packages/apigen/plugins/py-grpc/src/lib/`),
 * `__dirname` resolves correctly via four `..` steps to `packages/apigen/python`.
 *
 * When running inside the vite-bundled CLI (`dist/packages/apigen/cli/index.js`),
 * `__dirname` points at the bundle output dir; we walk up searching for the repo root.
 */
function resolvePythonPkgDir(): string {
  // Primary: source-relative path (works in direct source execution and tests).
  const primary = path.resolve(__dirname, '..', '..', '..', '..', 'python')
  if (fs.existsSync(path.join(primary, 'apigen_python'))) return primary

  // Fallback: walk up from __dirname searching for `packages/apigen/python`.
  let dir = __dirname
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'packages', 'apigen', 'python')
    if (fs.existsSync(path.join(candidate, 'apigen_python'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Last resort: return the primary candidate and let spawn fail clearly.
  return primary
}

/** The directory containing the Python apigen package sources. */
const PYTHON_PKG_DIR = resolvePythonPkgDir()

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
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout })
    let settled = false

    function settle(fn: () => void) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => reject(new Error('py-grpc: timed out waiting for {"ready":true}')))
    }, timeoutMs)

    rl.on('line', (line: string) => {
      const trimmed = line.trim()
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>
        if (msg['ready'] === true) {
          settle(() => resolve())
        }
      } catch {
        // Not JSON — ignore; the server may log non-JSON lines
      }
    })

    proc.on('exit', (code) => {
      settle(() => reject(new Error(`py-grpc: python process exited prematurely (code ${code})`)))
    })
  })
}

// ---------------------------------------------------------------------------
// run() — spawn the Python gRPC server
// ---------------------------------------------------------------------------

async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number | string | undefined) ?? 50051
  const host = (input.options['host'] as string | undefined) ?? '127.0.0.1'

  // Determine the source file and namespace from RunInput.
  // Convention: packages[0].id is the namespace; importPath is the .py file.
  const pkg = input.packages[0]
  if (!pkg) {
    throw new Error('py-grpc plugin: no package in RunInput.packages')
  }

  const namespace = (input.options['namespace'] as string | undefined) ?? pkg.id
  const modulePath = pkg.importPath

  if (!modulePath.endsWith('.py')) {
    throw new Error(
      `py-grpc plugin: --source must point to a .py file, got: ${modulePath}`,
    )
  }

  const proc = spawn(
    'python3',
    [
      '-m', 'apigen_python.grpc_server',
      '--module', modulePath,
      '--namespace', namespace,
      '--host', String(host),
      '--port', String(port),
    ],
    {
      cwd: PYTHON_PKG_DIR,
      env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams

  // Forward stderr from the Python process to our own stderr so the user
  // sees service/method logs.
  proc.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
  })

  // Wait for the readiness signal before resolving — ensures callers (the CLI,
  // tests, the gateway) can start sending requests immediately.
  await waitForReady(proc)

  // Block until the signal fires (SIGINT/SIGTERM → controller.abort())
  // or the process exits unexpectedly.
  return new Promise<void>((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(new Error(`py-grpc: python process exited with code ${code}`))
      }
    })

    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM')
        resolve()
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const pyGrpcPlugin: OutputPlugin = {
  id: 'py-grpc',
  description: 'Serve Python functions over gRPC (grpcio; in-memory descriptors; reflection enabled)',
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
    return { files: [] }
  },
  run,
}

export default pyGrpcPlugin
