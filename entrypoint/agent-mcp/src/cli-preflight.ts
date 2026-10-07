/**
 * Side-effect module: MUST be the first import of `index.ts`.
 *
 * ES module imports are evaluated in order, so this runs before any later
 * import (`./db/client.js` opens the operational SQLite DB at import time).
 * When the process was launched as the `agent-mcp` bin with `--help`,
 * `--version`, or an unknown argument, it answers and exits here — no DB is
 * opened, nothing is migrated, no policy file is written, no server starts.
 *
 * It does nothing when `index.js` is merely imported (tests, library use) or
 * when the bin is launched with no arguments.
 */
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseServerArgs, usageText } from './cli-args.js';

function launchedAsServerBin(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // Sibling of this file: `index.js` in dist; absent from a ts source tree.
    const index = fileURLToPath(new URL('./index.js', import.meta.url));
    return realpathSync(entry) === realpathSync(index);
  } catch {
    return false;
  }
}

if (launchedAsServerBin()) {
  const action = parseServerArgs(process.argv.slice(2));
  if (action.kind === 'help') {
    process.stdout.write(usageText());
    process.exit(0);
  } else if (action.kind === 'version') {
    // Published layout: dist/src/ -> dist/package.json (generated manifest).
    // In-source build output (no dist-manifest run yet): the project's own
    // package.json sits one level higher.
    const req = createRequire(import.meta.url);
    let version: string | undefined;
    for (const rel of ['../package.json', '../../package.json']) {
      try {
        version = (req(rel) as { version: string }).version;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (version === undefined) {
      process.stderr.write('agent-mcp: unable to determine version (package.json not found)\n');
      process.exit(1);
    }
    process.stdout.write(`${version}\n`);
    process.exit(0);
  } else if (action.kind === 'unknown') {
    process.stderr.write(`agent-mcp: unknown argument(s): ${action.args.join(' ')}\n\n${usageText()}`);
    process.exit(2);
  }
}
