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
 * Find the shaded/fat jar `packages/apigen/java`'s `package` target
 * produces. Builds it (mvn package -DskipTests) if not already present —
 * mirrors the "spawning a process / needing a build first is the test's job,
 * not a reason to gate" testing standard (AGENTS.md §7): callers never need
 * to remember to build the Java module first.
 */
function findFatJar(javaPkgDir: string): string {
  const targetDir = path.join(javaPkgDir, 'target');

  // ALWAYS run `mvn package` rather than reusing a pre-existing *-all.jar
  // unconditionally: Maven's own incremental compiler already no-ops (fast)
  // when nothing changed, but reusing a stale jar unconditionally would mask
  // real source changes (e.g. a fixed bug in ApigenJavalinServer.java) that
  // a caller with a Java source edit but no manual `mvn package` run would
  // otherwise silently keep exercising.
  const mvn = resolveMvn();
  const result = spawnSync(mvn, ['-q', '-pl', '.', 'package', '-DskipTests'], {
    cwd: javaPkgDir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(
      `java-javalin: mvn package failed to build apigen-java's fat jar (exit ${String(result.status)}):\n${result.stderr ?? ''}`
    );
  }
  const rebuilt = fs.readdirSync(targetDir).find((f) => f.endsWith('-all.jar'));
  if (!rebuilt) {
    throw new Error(
      `java-javalin: mvn package succeeded but no *-all.jar found in ${targetDir}`
    );
  }
  return path.join(targetDir, rebuilt);
}

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
