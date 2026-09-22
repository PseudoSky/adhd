/**
 * @adhd/apigen-plugin-java-javalin — Java HTTP target for apigen
 * (FEAT-APIGEN-001 slice 1/3).
 *
 * Serves a Java `.java` file over real HTTP via a TWO-PHASE SPAWN, mirroring
 * `apigen-plugin-py-flask/src/lib/plugin.ts`'s exact shape — see that file's
 * module doc comment for the full rationale (`--plan-file` temp-file wire
 * format, readiness-line protocol, `project()` route derivation).
 *
 *   1. Spawn `mvn -q -pl packages/apigen/java exec:java
 *      -Dexec.mainClass=com.adhd.apigen.extractor.ApigenJavaExtractor
 *      -Dexec.args="--source <path> --namespace <ns> --emit-json"` (phase 1,
 *      extract-only) and parse its stdout (a bare JSON array — see
 *      `ApigenJavaExtractor`'s doc comment for why this deviates from an
 *      earlier `{"operations":[...]}` envelope description: every existing
 *      two-phase caller, `runExtractorEmitJson`, does `JSON.parse(stdout) as
 *      Operation[]` — a bare array is the REAL, load-bearing wire contract).
 *   2. Call the REAL `@adhd/apigen-engine-naming` `project(op)` on each op —
 *      the SAME canonical projector every other host derives its routes
 *      from — to compute `{route, verb}` per op.
 *   3. Render `GeneratedDispatcher.java` via `renderDispatcherJava`
 *      (codegen-woven glue — DESIGN §2/§77-83, NOT reflection into the
 *      user's methods), `javac` it together with the user's `.java` source
 *      into a temp classes dir (classpath = the module's shaded/fat jar, so
 *      Jackson/Javalin types resolve), then spawn `ApigenJavalinServer
 *      --plan-file <path> --classes-dir <path>`, waiting (bounded, no
 *      sleep-polling) for a `{"ready":true,"port":<n>}` stdout line —
 *      identical protocol to py-flask's `waitForReady`.
 *
 * Batch (`_batch/<kind>`) fan-out mounting is explicitly OUT of scope for
 * this slice (py-flask's `usePlugins`/`buildBatchMountedOperations` wiring is
 * NOT mirrored here) — the codegen-woven dispatcher model has no equivalent
 * of Python's dynamically-imported-module fan-out yet; tracked as a
 * follow-on (FEAT-APIGEN-001 slice 2/3 or later).
 *
 * Usage:
 *   apigen run --source my_api.java --type java-javalin --opt port=8000 --opt namespace=myapi
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { OutputPlugin, RunInput } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { renderDispatcherJava, type JavaOperation } from './dispatcher-template';

// ---------------------------------------------------------------------------
// apigen-java module resolution
// ---------------------------------------------------------------------------

/**
 * Locate `packages/apigen/java` (the Maven module) by walking up from this
 * file's own directory to the first ancestor that contains it — mirrors
 * `resolvePythonPkgDir` in `@adhd/apigen-python-env`. Works both from source
 * (`src/lib/plugin.ts`, 3 levels under the workspace `packages/apigen/`
 * sibling) and from the built `dist/index.js`.
 */
export function resolveJavaPkgDir(fromDir: string = __dirname): string {
  let dir = fromDir;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'packages', 'apigen', 'java');
    if (fs.existsSync(path.join(candidate, 'pom.xml'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Co-located fallback (in case a future packaging layout ships java/ next
  // to this plugin's own dist).
  const coLocated = path.join(fromDir, '..', 'java');
  return coLocated;
}

function resolveMvn(): string {
  const override = process.env['APIGEN_MVN'];
  if (override) return override;
  const check = spawnSync('mvn', ['-version'], { stdio: 'ignore' });
  if (check.error === undefined && check.status === 0) return 'mvn';
  if (fs.existsSync('/opt/homebrew/bin/mvn')) return '/opt/homebrew/bin/mvn';
  throw new Error(
    'java-javalin plugin: `mvn` not found on PATH or at /opt/homebrew/bin/mvn. ' +
      'Install Maven (human-approved external tool) or set APIGEN_MVN.'
  );
}

// ---------------------------------------------------------------------------
// Phase 1 — spawn ApigenJavaExtractor --emit-json -> JavaOperation[]
// ---------------------------------------------------------------------------

function runExtractorEmitJsonJava(
  mvn: string,
  javaPkgDir: string,
  sourcePath: string,
  namespace: string
): Promise<JavaOperation[]> {
  return new Promise<JavaOperation[]>((resolve, reject) => {
    const proc = spawn(
      mvn,
      [
        '-q',
        '-pl',
        '.',
        // 'compile' first — exec:java as a standalone goal invocation does
        // NOT run through the default lifecycle, so target/classes must
        // already exist (Maven caches/no-ops a repeat compile, so this is
        // cheap on every call after the first).
        'compile',
        'exec:java',
        '-Dexec.mainClass=com.adhd.apigen.extractor.ApigenJavaExtractor',
        `-Dexec.args=--source ${sourcePath} --namespace ${namespace} --emit-json`,
      ],
      { cwd: javaPkgDir, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(`java-javalin: extractor --emit-json exited with code ${code}:\n${stderr}`)
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as JavaOperation[]);
      } catch (err) {
        reject(
          new Error(
            `java-javalin: extractor --emit-json produced invalid JSON (${(err as Error).message}):\n${stdout}`
          )
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Phase 2.5 — javac the generated dispatcher + user source into a temp dir
// ---------------------------------------------------------------------------

function compileGeneratedDispatcher(
  javaPkgDir: string,
  userSourcePath: string,
  dispatcherSource: string,
  classesDir: string
): void {
  const tmpSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-java-src-'));
  const userDest = path.join(tmpSrcDir, path.basename(userSourcePath));
  fs.copyFileSync(userSourcePath, userDest);
  const dispatcherFile = path.join(tmpSrcDir, 'GeneratedDispatcher.java');
  fs.writeFileSync(dispatcherFile, dispatcherSource, 'utf-8');

  const fatJar = findFatJar(javaPkgDir);
  fs.mkdirSync(classesDir, { recursive: true });

  const result = spawnSync(
    'javac',
    ['-cp', fatJar, '-d', classesDir, userDest, dispatcherFile],
    { encoding: 'utf-8' }
  );
  fs.rmSync(tmpSrcDir, { recursive: true, force: true });

  if (result.status !== 0) {
    throw new Error(
      `java-javalin: javac failed (exit ${String(result.status)}):\n${result.stderr ?? ''}`
    );
  }
}

/**
 * Is this process running as (or descended from) an Nx task?
 *
 * Nx sets `NX_TASK_TARGET_TARGET` (plus `_PROJECT`/`_CONFIGURATION`) on every
 * task process — see `nx/src/tasks-runner/task-env.js`
 * (`getNxEnvVariablesForTask`) — and every child spawned from it inherits
 * them, including the `tsx` fixture subprocess `process-cleanup.spec.ts`
 * spawns.
 *
 * DETECTION CHOICE (BUG 14614478): we key off Nx's own env marker rather than
 * a purpose-built opt-in flag because the executor both consuming test targets
 * use — `@nx/vite:test` — declares NO `env` option in its schema (only
 * `nx:run-commands` does), so project.json alone offers no supported way to
 * inject a custom flag into the vitest process. Nx's marker is present for
 * free, is inherited across the whole process tree, and is absent for a
 * standalone `apigen run`.
 *
 * The contract under Nx is that the task graph is responsible for ordering:
 * the consuming targets declare `apigen-java:package` in their `dependsOn`,
 * so a fresh, cached `target/*-all.jar` already exists before we run. Under
 * Nx we therefore LOCATE that jar and NEVER spawn `mvn` — spawning a second
 * `mvn package` here is exactly what raced two concurrent shade builds over
 * the shared `dependency-reduced-pom.xml` / `target/*.jar`.
 */
function isNxTask(): boolean {
  return (process.env['NX_TASK_TARGET_TARGET'] ?? '') !== '';
}

/**
 * The shaded-jar filename `packages/apigen/java/pom.xml` declares. Maven's
 * attached shaded artifact is named `<finalName>-<shadedClassifierName>.jar`
 * (the pom sets `finalName` to `apigen-java` and `shadedClassifierName` to
 * `all`, i.e. `apigen-java-all.jar`). Returns `undefined` when either element
 * is absent, so the caller falls back to newest-mtime selection.
 */
function expectedFatJarName(javaPkgDir: string): string | undefined {
  try {
    const pom = fs.readFileSync(path.join(javaPkgDir, 'pom.xml'), 'utf-8');
    const finalName = /<finalName>\s*([^<\s]+)\s*<\/finalName>/.exec(pom)?.[1];
    if (!finalName) return undefined;
    const classifier =
      /<shadedClassifierName>\s*([^<\s]+)\s*<\/shadedClassifierName>/.exec(
        pom
      )?.[1] ?? 'all';
    return `${finalName}-${classifier}.jar`;
  } catch {
    return undefined;
  }
}

/**
 * Deterministically choose the shaded fat jar in `target/`.
 *
 * The previous `readdirSync(targetDir).find((f) => f.endsWith('-all.jar'))`
 * returned whichever candidate the filesystem happened to list FIRST, so a
 * stale `*-all.jar` left behind by an earlier build (e.g. a different
 * `<finalName>`/version — `target/` is not emptied between builds) could be
 * selected instead of the jar the current build produced, making a test
 * outcome depend on readdir order (backlog 7e3852df). We (1) prefer the exact
 * filename `pom.xml` declares, and (2) otherwise pick the NEWEST by mtime,
 * breaking ties by name so the result is a total order.
 */
export function selectFatJar(javaPkgDir: string): string | undefined {
  const targetDir = path.join(javaPkgDir, 'target');
  if (!fs.existsSync(targetDir)) return undefined;

  const expected = expectedFatJarName(javaPkgDir);
  if (expected && fs.existsSync(path.join(targetDir, expected))) {
    return expected;
  }

  const candidates = fs
    .readdirSync(targetDir)
    .filter((f) => f.endsWith('-all.jar'));
  if (candidates.length === 0) return undefined;

  return candidates
    .map((name) => ({
      name,
      mtimeMs: fs.statSync(path.join(targetDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0]
    .name;
}

/**
 * Find the shaded/fat jar `packages/apigen/java`'s `package` target
 * produces.
 *
 * Under Nx (`isNxTask()`): the task graph has already built it via the
 * `apigen-java:package` dependency — locate the prebuilt `*-all.jar` and
 * never spawn `mvn`. If it is absent we FAIL LOUDLY (never fall back to
 * spawning), because that means the `apigen-java:package` wiring or its cache
 * restore is broken — a defect to surface, not paper over.
 *
 * Standalone (no Nx task, e.g. a direct `apigen run`): preserve the original
 * freshness guarantee and ALWAYS run `mvn package`. Maven's own incremental
 * compiler already no-ops (fast) when nothing changed, but reusing a stale
 * jar unconditionally would mask real source changes (e.g. a fixed bug in
 * ApigenJavalinServer.java) that a caller with a Java edit but no manual
 * `mvn package` run would otherwise silently keep exercising.
 */
function findFatJar(javaPkgDir: string): string {
  const targetDir = path.join(javaPkgDir, 'target');

  if (isNxTask()) {
    const prebuilt = selectFatJar(javaPkgDir);
    if (!prebuilt) {
      throw new Error(
        `java-javalin: running under Nx (NX_TASK_TARGET_TARGET=${String(
          process.env['NX_TASK_TARGET_TARGET']
        )}) but no prebuilt *-all.jar found in ${targetDir}. The Nx task graph must build it: ` +
          `declare "apigen-java:package" in this target's dependsOn. ` +
          `Refusing to spawn mvn here — a second concurrent "mvn package" is the shade-plugin race (BUG 14614478).`
      );
    }
    return path.join(targetDir, prebuilt);
  }

  const mvn = resolveMvn();
  const result = spawnSync(mvn, ['-q', '-pl', '.', 'package', '-DskipTests'], {
    cwd: javaPkgDir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    // Include BOTH streams: Maven prints its real `[ERROR]` diagnostics to
    // STDOUT (the shade-plugin failures that caused this race did), while
    // only JVM/plugin startup warnings go to STDERR — interpolating stderr
    // alone silently discarded the real cause (BUG 73741a3c).
    throw new Error(
      `java-javalin: mvn package failed to build apigen-java's fat jar (exit ${String(result.status)}):\n` +
        `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`
    );
  }
  const rebuilt = selectFatJar(javaPkgDir);
  if (!rebuilt) {
    throw new Error(
      `java-javalin: mvn package succeeded but no *-all.jar found in ${targetDir}`
    );
  }
  return path.join(targetDir, rebuilt);
}

// ---------------------------------------------------------------------------
// Process-lifecycle hygiene (BUG-006 root cause, fix #1) — kill any live
// child JVM this module spawned if THIS Node process itself dies, not only
// when the caller's `AbortSignal` fires. The existing `input.signal`-driven
// path (below, in `run()`) only helps a caller that both wires an
// `AbortSignal` AND lives long enough to fire it; it does nothing if the
// parent process is itself SIGKILLed (OOM) or torn down by a test-runner
// worker pool that never propagates an abort. These handlers are the
// independent, unconditional backstop — see
// docs/backlog/grooming/test-perf-improvements.md #1.
// ---------------------------------------------------------------------------

const liveJavaChildren = new Set<ChildProcessWithoutNullStreams>();
let lifecycleHandlersInstalled = false;

function isStillAlive(proc: ChildProcessWithoutNullStreams): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function killChildImmediately(proc: ChildProcessWithoutNullStreams): void {
  try {
    if (isStillAlive(proc)) {
      proc.kill('SIGKILL');
    }
  } catch {
    // Already dead / ESRCH-equivalent race — nothing left to do.
  }
}

/**
 * Registers `process`-level exit/signal handlers exactly once per process.
 * Idempotent by design: `run()` may be called multiple times (multiple
 * servers spawned from one Node process, as the test suite does), and must
 * not accumulate duplicate listeners.
 */
function installProcessLifecycleHandlers(): void {
  if (lifecycleHandlersInstalled) return;
  lifecycleHandlersInstalled = true;

  // `exit` handlers run synchronously with no further event-loop turns
  // available before the process actually terminates — there is no time for
  // a SIGTERM-then-wait grace period, so go straight to SIGKILL. This is the
  // path that fires on an uncaught exception unwinding to exit, or a normal
  // `process.exit()` call anywhere in the process — the exact shape of "the
  // parent died and nothing else ever ran the AbortSignal path."
  process.on('exit', () => {
    for (const proc of liveJavaChildren) {
      killChildImmediately(proc);
    }
  });

  // SIGTERM/SIGINT are the signals a supervising test runner, shell, or
  // process-group teardown sends for a graceful shutdown. Registering a
  // listener here overrides Node's own default behavior of terminating
  // immediately, so this handler must reproduce that default itself
  // (`process.exit`) once cleanup has had its grace period.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      // Only WE should reproduce Node's "terminate on this signal" default
      // if we're the sole listener. If a consumer (apigen-cli, a test
      // runner, ...) has registered its own handler for the same signal,
      // it owns the process's overall shutdown sequence — we still kill our
      // own children unconditionally, but defer to that other handler for
      // actually exiting the process, so we don't truncate its cleanup.
      const soleListener = process.listenerCount(sig) === 1;

      const pending = Array.from(liveJavaChildren);
      for (const proc of pending) {
        try {
          if (isStillAlive(proc)) {
            proc.kill('SIGTERM');
          }
        } catch {
          // Already dead — nothing left to signal.
        }
      }
      const graceTimer = setTimeout(() => {
        for (const proc of pending) {
          killChildImmediately(proc);
        }
        if (soleListener) {
          process.exit(sig === 'SIGTERM' ? 143 : 130);
        }
      }, 3000);
      graceTimer.unref();
    });
  }
}

installProcessLifecycleHandlers();

// ---------------------------------------------------------------------------
// Readiness wait (identical protocol to py-flask's waitForReady)
// ---------------------------------------------------------------------------

function waitForReady(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs = 30_000
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
        reject(new Error('java-javalin: timed out waiting for {"ready":true}'))
      );
    }, timeoutMs);

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        if (msg['ready'] === true) {
          settle(() => resolve(msg['port'] as number));
        }
      } catch {
        // Not JSON — Javalin/Jetty startup logs are non-JSON lines; ignore.
      }
    });

    proc.on('exit', (code) => {
      settle(() =>
        reject(
          new Error(`java-javalin: java process exited prematurely (code ${code})`)
        )
      );
    });
  });
}

// ---------------------------------------------------------------------------
// run() — two-phase spawn: extract-only, then project(), then serve.
// ---------------------------------------------------------------------------

interface ServePlanRoute {
  route: string;
  verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

interface ServePlan {
  operations: JavaOperation[];
  routes: Record<string, ServePlanRoute>;
}

async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number | string | undefined) ?? 8000;
  const host = (input.options['host'] as string | undefined) ?? '127.0.0.1';

  const pkg = input.packages[0];
  if (!pkg) {
    throw new Error('java-javalin plugin: no package in RunInput.packages');
  }

  const namespace = (input.options['namespace'] as string | undefined) ?? pkg.id;
  const sourcePath = pkg.importPath;

  if (!sourcePath.endsWith('.java')) {
    throw new Error(
      `java-javalin plugin: --source must point to a .java file, got: ${sourcePath}`
    );
  }

  const javaPkgDir = resolveJavaPkgDir();
  if (!fs.existsSync(path.join(javaPkgDir, 'pom.xml'))) {
    throw new Error(
      `java-javalin plugin: could not locate packages/apigen/java (Maven module) from ${javaPkgDir}`
    );
  }
  const mvn = resolveMvn();

  // ---- Phase 1: extract-only subprocess -> JavaOperation[] ----
  const operations = await runExtractorEmitJsonJava(
    mvn,
    javaPkgDir,
    path.resolve(sourcePath),
    namespace
  );

  // ---- Phase 2: canonical route/verb via the REAL project() ----
  const routes: Record<string, ServePlanRoute> = {};
  for (const op of operations) {
    const projected = project(op);
    routes[op.id] = { route: projected.http.route, verb: projected.http.verb };
  }
  const plan: ServePlan = { operations, routes };

  // ---- Phase 2.5: render + compile the codegen-woven dispatcher ----
  const dispatcherSource = renderDispatcherJava(operations);
  const classesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-java-classes-'));
  try {
    compileGeneratedDispatcher(javaPkgDir, path.resolve(sourcePath), dispatcherSource, classesDir);
  } catch (err) {
    fs.rmSync(classesDir, { recursive: true, force: true });
    throw err;
  }

  // ---- Phase 3: write the plan to a temp file and spawn ApigenJavalinServer ----
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-java-plan-'));
  const planPath = path.join(planDir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan));

  const fatJar = findFatJar(javaPkgDir);

  const cleanup = (): void => {
    fs.rmSync(planDir, { recursive: true, force: true });
    fs.rmSync(classesDir, { recursive: true, force: true });
  };

  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(
      'java',
      [
        '-cp',
        `${classesDir}${path.delimiter}${fatJar}`,
        'com.adhd.apigen.runtime.ApigenJavalinServer',
        '--plan-file',
        planPath,
        '--classes-dir',
        classesDir,
        '--host',
        String(host),
        '--port',
        String(port),
        '--namespace',
        namespace,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ) as ChildProcessWithoutNullStreams;
  } catch (err) {
    cleanup();
    throw err;
  }

  // Register with the process-lifecycle backstop the moment the JVM exists —
  // independent of (and in addition to) the AbortSignal-driven path below.
  liveJavaChildren.add(proc);
  proc.once('exit', () => {
    liveJavaChildren.delete(proc);
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  let boundPort: number;
  try {
    boundPort = await waitForReady(proc);
  } catch (err) {
    cleanup();
    throw err;
  }

  // Cleanup happens on process exit (below), not immediately after
  // readiness: the generated dispatcher's compiled .class files in
  // classesDir must remain on the running JVM's classpath for its lifetime
  // (unlike py-flask's plan file, which flask_server.py reads once at
  // startup and never touches again).
  const onListening = input.options['onListening'] as
    | ((port: number) => void)
    | undefined;
  onListening?.(boundPort);

  return new Promise<void>((resolve, reject) => {
    proc.on('exit', (code) => {
      cleanup();
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`java-javalin: java process exited with code ${code}`));
      }
    });

    if (input.signal) {
      input.signal.addEventListener('abort', () => {
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

export const javaJavalinPlugin: OutputPlugin = {
  id: 'java-javalin',
  description: 'Serve Java public static methods over HTTP (JavaParser + Javalin, codegen-woven dispatch)',
  language: 'java',
  optionsSchema: {
    type: 'object',
    properties: {
      port: { type: 'number', default: 8000 },
      host: { type: 'string', default: '127.0.0.1' },
      namespace: { type: 'string' },
    },
  },
  generate(_input) {
    // java-javalin is a run-only plugin; no static codegen output.
    return { files: [] };
  },
  run,
};

export default javaJavalinPlugin;
