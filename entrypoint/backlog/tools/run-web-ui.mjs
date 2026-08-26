#!/usr/bin/env node
/**
 * run-web-ui.mjs — one command to launch the backlog web UI prototype.
 *
 * Spawns two children and owns their lifecycle:
 *
 *   1. the backlog API  — `node dist/index.js serve --transport http --port <api>`
 *                         (the REAL built CLI entrypoint, same one a consumer
 *                         installs from npm)
 *   2. the web server   — `node tools/web-ui-server.mjs --port <web> --api <api>`
 *                         (static UI + same-origin proxy)
 *
 * Waits for the API to be reachable (bounded poll on /_meta/openapi) before
 * starting the web server, prints both URLs, then runs until SIGINT/SIGTERM.
 * If either child dies unexpectedly, the other is killed and the process
 * exits non-zero so a scripted caller (or the nx `serve` task, which is the
 * primary consumer) sees the failure.
 *
 * Usage:
 *   node tools/run-web-ui.mjs [--api-port N] [--web-port N] [--host H] [--sandbox]
 *
 *   --sandbox  passes the CLI's `--sandbox` flag through: the API serves an
 *              isolated throwaway store instead of the real production graph
 *              (prints the isolated path; not auto-deleted, per the CLI
 *              contract).
 *
 * Env passthrough: ADHD_BACKLOG_SCOPE / ADHD_ENV_SCOPE /
 * ADHD_BACKLOG_DATABASE_PATH are inherited by the API child exactly as the
 * CLI would honor them.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, '..', 'dist', 'index.js');

const args = process.argv.slice(2);
const opts = { apiPort: 3300, webPort: 4173, host: '127.0.0.1', sandbox: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--api-port') opts.apiPort = Number(args[++i]);
  else if (a === '--web-port') opts.webPort = Number(args[++i]);
  else if (a === '--host') opts.host = args[++i];
  else if (a === '--sandbox') opts.sandbox = true;
  else throw new Error(`run-web-ui: unknown argument "${a}" (expected --api-port/--web-port/--host/--sandbox)`);
}

const apiUrl = `http://${opts.host}:${opts.apiPort}`;
const children = new Set();
let shuttingDown = false;

function spawnChild(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) return; // we asked it to die
    process.stderr.write(`[run-web-ui] ${name} exited unexpectedly (code=${code} signal=${signal}) — shutting down\n`);
    for (const other of children) other.kill('SIGTERM');
    process.exitCode = 1;
  });
  return child;
}

/** Bounded readiness poll — deterministic, no fixed sleeps. */
async function waitFor(urlPath, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(apiUrl + urlPath, { signal: AbortSignal.timeout(1500) });
      if (res.ok || res.status >= 400) {
        process.stderr.write(`[run-web-ui] ${label} ready (${urlPath} -> ${res.status})\n`);
        return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`[run-web-ui] ${label} did not become ready within ${timeoutMs}ms (api: ${apiUrl})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main() {
  const apiArgs = ['serve', '--transport', 'http', '--port', String(opts.apiPort), '--host', opts.host];
  if (opts.sandbox) apiArgs.push('--sandbox');

  spawnChild('api', process.execPath, [CLI_ENTRY, ...apiArgs]);
  await waitFor('/_meta/openapi', 30_000, 'api');

  spawnChild('web', process.execPath, [
    join(HERE, 'web-ui-server.mjs'),
    '--port', String(opts.webPort),
    '--host', opts.host,
    '--api', apiUrl,
  ]);

  process.stdout.write('\n');
  process.stdout.write('  backlog web ui running:\n');
  process.stdout.write(`    ui : http://${opts.host}:${opts.webPort}/\n`);
  process.stdout.write(`    api: ${apiUrl}/backlog/query (POST {data:{input}})\n`);
  process.stdout.write('  press Ctrl-C to stop\n\n');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shuttingDown = true;
    for (const child of children) child.kill('SIGTERM');
    // Let the children exit; the process ends when both have.
  });
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n');
  process.exitCode = 1;
  for (const child of children) child.kill('SIGTERM');
});
