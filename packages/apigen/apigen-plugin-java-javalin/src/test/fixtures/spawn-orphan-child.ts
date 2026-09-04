/**
 * Test harness subprocess for `process-cleanup.spec.ts` — this file is NOT a
 * test itself; it is spawned as a real, independent Node process by the spec
 * so the spec can send it a REAL `SIGTERM`/`SIGINT` from outside, the exact
 * shape of BUG-006 (a vitest worker pool / OS OOM killing the parent Node
 * process abruptly).
 *
 * It calls the plugin's real `run()` with NO `AbortSignal` wired at all —
 * deliberately, to prove that `../../lib/plugin.ts`'s process-lifecycle
 * backstop (`installProcessLifecycleHandlers`, registered unconditionally at
 * module load) is what kills the JVM child, not the pre-existing
 * `AbortSignal`-driven path (which this harness intentionally never uses).
 *
 * Protocol: prints a single line `READY <pid>` to stdout once the server is
 * listening, where `<pid>` is this harness process's own pid (so the parent
 * test doesn't need a second IPC channel to correlate). The parent test then
 * finds the live `java` child via `pgrep -P <this pid>`, sends this harness
 * process a real SIGTERM/SIGINT, and polls (bounded) for that child pid to
 * disappear.
 */
import * as path from 'node:path';
import { javaJavalinPlugin } from '../../lib/plugin';
import type { RunInput } from '@adhd/apigen-core-client';

const FIXTURE = path.resolve(
  __dirname,
  '../../../../java/src/test/resources/OrderApi.java'
);

const OUTPUT_DIR = path.resolve(__dirname, '../../../../../../tmp/apigen-plugin-java-javalin/process-cleanup-spec');

async function main(): Promise<void> {
  const input: RunInput = {
    packages: [{ id: 'orders', schemas: {}, importPath: FIXTURE }],
    outputDir: OUTPUT_DIR,
    options: {
      port: 0,
      host: '127.0.0.1',
      namespace: 'orders',
      onListening: () => {
        process.stdout.write(`READY ${process.pid}\n`);
      },
    },
    // Deliberately NO `signal` — see file header. This harness exists to
    // prove the process.on('SIGTERM'|'SIGINT'|'exit') backstop works even
    // when a caller never wires an AbortSignal at all.
  };

  if (!javaJavalinPlugin.run) {
    throw new Error('javaJavalinPlugin.run is not defined');
  }
  await javaJavalinPlugin.run(input);
}

main().catch((err) => {
  // Expected in the success path of this harness: run()'s returned promise
  // rejects once the JVM is killed by the SIGTERM/SIGKILL the test sends —
  // by the time it does, the SIGTERM handler in plugin.ts has already
  // called `process.exit()`, so this rarely has a chance to run at all.
  process.stderr.write(`harness run() ended: ${String(err)}\n`);
});
