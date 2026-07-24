/**
 * @adhd/apigen-plugin-py-flask — Python HTTP target for apigen.
 *
 * Serves a Python `.py` module over real HTTP via a TWO-PHASE spawn
 * (apigen-serve-core `py-flask-serve-split`):
 *
 *   1. Spawn `python3 -m apigen_python.extractor --emit-json` (short-lived,
 *      extract-only) and parse its stdout into `Operation[]`.
 *   2. Call the REAL `@adhd/apigen-engine-naming` `project(op)` on each op —
 *      the SAME canonical projector `api-fastify`/`api-express`/`mcp`/`cli`
 *      all derive their routes from — to compute `{route, verb}` per op.
 *   3. Serialize `{operations, routes}` to a temp JSON file and spawn
 *      `python3 -m apigen_python.flask_server ... --plan-file <path>`; the
 *      Python server builds its route table from this INJECTED plan instead
 *      of self-extracting or re-deriving route/verb.
 *
 * Route contract (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 — byte-identical
 * to `@adhd/apigen-engine-naming`'s `project(op).http`, the SAME derivation the
 * `openapi` mount plugin uses):
 *   POST <route>        body: {"data":{<param>:…}}
 *   GET  <route>        query-string (safe OR primitive-only-input ops)
 *   GET  /_meta/health  → {"status":"ok","host":"<ns>"}
 *   <route> = '/' + [namespace, ...path].map(toKebab).join('/')
 *
 * Before this split, `apigen_python/flask_server.py` carried a hand-
 * maintained Python re-implementation of `project()`'s route/verb formula
 * (`_route_for_op()` / `_http_verb()` / `_is_primitive_only_input_schema()`)
 * because Python cannot import the TS package and there was no IPC channel
 * to carry a TS-computed value across the process boundary. That channel is
 * this file's two-phase spawn — the Python re-derivation was DELETED, not
 * kept as a fallback (see `flask_server.py`'s module docstring).
 *
 * `--plan-file` wire format: a temp JSON FILE (`fs.mkdtemp` + `--plan-file
 * <path>`), not a `--plan '<json>'` argv string. Chosen because (a) argv has
 * a real, OS-dependent size ceiling (`ARG_MAX`) that a module with many
 * operations and large JSON-Schema fragments can plausibly exceed, and (b)
 * JSON containing quotes/backslashes round-trips through shell argv
 * quoting unreliably across platforms, whereas a file has neither problem.
 * This matches existing repo convention for TS↔Python subprocess IPC
 * payloads (`@adhd/apigen-python-env`'s wheel-build temp dir,
 * `fs.mkdtempSync(path.join(os.tmpdir(), …))`).
 *
 * Unlike the TS-extraction plugins (api-fastify/api-express/mcp), this
 * plugin still never sees an `Operation[]` on `RunInput` — `RunInput.operations`
 * is absent for non-TS-extraction run paths (the CLI's `run` command routes
 * `.py` sources straight to `plugin.run()` with an empty `schemas: {}`
 * package stub; see `entrypoint/apigen-cli/src/lib/commands/run.ts`).
 * Instead, THIS plugin obtains `Operation[]` itself via phase 1 above.
 *
 * The Python server emits `{"ready":true}` on stdout immediately after
 * binding the port.  This plugin waits for that line (bounded to 10 s)
 * before resolving, so downstream tools know the server is ready.
 *
 * Usage:
 *   apigen run --source my_api.py --type py-flask --opt port=8000 --opt namespace=myapi
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
        reject(new Error('py-flask: timed out waiting for {"ready":true}'))
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
          new Error(
            `py-flask: python process exited prematurely (code ${code})`
          )
        )
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Phase 1 — spawn `apigen_python.extractor --emit-json` (short-lived,
// extract-only) and parse its stdout into Operation[].
// ---------------------------------------------------------------------------

/**
 * One entry of the `--plan-file` payload's `routes` map — TS-computed via
 * the real `project()`, never re-derived Python-side.
 */
interface ServePlanRoute {
  route: string;
  verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

/** The `--plan-file` JSON payload `flask_server.py`'s `_build_state()` consumes. */
interface ServePlan {
  operations: Operation[];
  routes: Record<string, ServePlanRoute>;
}

/**
 * Runs `python -m apigen_python.extractor --emit-json` to completion and
 * parses its stdout into `Operation[]` — phase 1 of the two-phase spawn
 * (module docstring). This is a short-lived process: it exits as soon as
 * extraction finishes, well before `flask_server` (phase 3) is spawned.
 */
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
            `py-flask: extractor --emit-json exited with code ${code}:\n${stderr}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Operation[]);
      } catch (err) {
        reject(
          new Error(
            `py-flask: extractor --emit-json produced invalid JSON (${
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

async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number | string | undefined) ?? 8000;
  const host = (input.options['host'] as string | undefined) ?? '127.0.0.1';

  // Determine the source file and namespace from RunInput.
  // Convention: packages[0].id is the namespace; importPath is the .py file.
  const pkg = input.packages[0];
  if (!pkg) {
    throw new Error('py-flask plugin: no package in RunInput.packages');
  }

  const namespace =
    (input.options['namespace'] as string | undefined) ?? pkg.id;
  const modulePath = pkg.importPath;

  if (!modulePath.endsWith('.py')) {
    throw new Error(
      `py-flask plugin: --source must point to a .py file, got: ${modulePath}`
    );
  }

  // Provision (or reuse) the managed interpreter — deps come from
  // apigen-python's own pyproject.toml, never the ambient PATH python.
  const pyenv = ensurePythonEnv({});

  // ---- Phase 1: extract-only subprocess -> Operation[] ----
  const operations = await runExtractorEmitJson(pyenv, modulePath, namespace);

  // ---- Phase 2: canonical route/verb via the REAL project() (never a
  // Python re-derivation — BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001) ----
  const routes: Record<string, ServePlanRoute> = {};
  for (const op of operations) {
    const projected = project(op);
    routes[op.id] = { route: projected.http.route, verb: projected.http.verb };
  }
  const plan: ServePlan = { operations, routes };

  // ---- Phase 3: write the plan to a temp file and spawn flask_server ----
  // See module docstring for why a temp FILE, not a `--plan '<json>'` argv
  // string, was chosen (ARG_MAX + shell-quoting risk).
  const planDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'apigen-py-flask-plan-')
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
        'apigen_python.flask_server',
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
  // sees route logs.
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
        reject(new Error(`py-flask: python process exited with code ${code}`));
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

export const pyFlaskPlugin: OutputPlugin = {
  id: 'py-flask',
  description:
    'Serve Python functions over HTTP (stdlib http.server; Flask optional)',
  language: 'py',
  optionsSchema: {
    type: 'object',
    properties: {
      port: { type: 'number', default: 8000 },
      host: { type: 'string', default: '127.0.0.1' },
      namespace: { type: 'string' },
    },
  },
  generate(_input) {
    // py-flask is a run-only plugin; no static codegen output.
    return { files: [] };
  },
  run,
};

export default pyFlaskPlugin;
