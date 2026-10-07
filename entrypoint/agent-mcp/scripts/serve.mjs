#!/usr/bin/env node
/**
 * agent-mcp dev server with live reload. Driven by the `serve`, `serve-status` and `serve-stop`
 * Nx targets (see README "Local dev server").
 *
 *   node scripts/serve.mjs run    [--port=47821]   foreground supervisor (what `nx run agent-mcp:serve` runs)
 *   node scripts/serve.mjs status [--port=47821]
 *   node scripts/serve.mjs stop   [--port=47821]
 *
 * Never builds. It waits for <projectRoot>/dist (src/index.js + package.json), starts the built
 * server over the streamable-HTTP transport, and restarts it (SIGTERM, then start) once the dist
 * has been unchanged for the stability window after any change.
 *
 * Env: AGENT_MCP_SERVE_PORT (default 47821), AGENT_MCP_SERVE_STABLE_MS (3000),
 *      AGENT_MCP_SERVE_POLL_MS (2000). All ADHD_AGENT_* vars pass through to the server unchanged
 *      (real registry/DB paths by default). pid/log: <workspace>/tmp/agent-mcp/serve/serve-<port>.{pid,log}
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(projectRoot, '..', '..');
const dist = path.join(projectRoot, 'dist');
const entry = path.join(dist, 'src', 'index.js');
const pkg = path.join(dist, 'package.json');

const [cmd = 'run', ...rest] = process.argv.slice(2);
const argPort = rest.map((a) => /^--port(?:=|$)/.test(a) ? (a.split('=')[1] ?? rest[rest.indexOf(a) + 1]) : undefined).find(Boolean);
const PORT = Number(argPort ?? process.env.AGENT_MCP_SERVE_PORT ?? 47821);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) { console.error(`invalid port: ${argPort ?? process.env.AGENT_MCP_SERVE_PORT}`); process.exit(2); }
const STABLE = Number(process.env.AGENT_MCP_SERVE_STABLE_MS ?? 3000);
const POLL = Number(process.env.AGENT_MCP_SERVE_POLL_MS ?? 2000);
const dir = path.join(workspaceRoot, 'tmp', 'agent-mcp', 'serve');
const PIDF = path.join(dir, `serve-${PORT}.pid`);
const LOG = path.join(dir, `serve-${PORT}.log`);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = () => { try { const n = Number(readFileSync(PIDF, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : undefined; } catch { return undefined; } };
const runningPid = () => { const p = readPid(); return p && alive(p) ? p : undefined; };
const url = `http://127.0.0.1:${PORT}/`;

if (cmd === 'status') {
  const p = runningPid();
  console.log(p ? `agent-mcp serve RUNNING supervisor pid=${p} url=${url} log=${LOG}` : `agent-mcp serve NOT running (port ${PORT})`);
  process.exit(p ? 0 : 3);
}
if (cmd === 'stop') {
  const p = runningPid();
  if (!p) { console.log(`agent-mcp serve not running (port ${PORT}); nothing to stop`); try { unlinkSync(PIDF); } catch { /* best effort */ } process.exit(0); }
  process.kill(p, 'SIGTERM');
  const t0 = Date.now();
  const wait = () => { if (!alive(p)) { console.log(`stopped supervisor pid=${p}`); process.exit(0); }
    if (Date.now() - t0 > 15000) { console.error(`supervisor ${p} did not exit within 15s`); process.exit(1); } setTimeout(wait, 200); };
  wait();
} else if (cmd === 'run') {
  const existing = runningPid();
  if (existing) { console.log(`agent-mcp serve already running: supervisor pid=${existing} url=${url} log=${LOG} (not starting another)`); process.exit(0); }
  mkdirSync(dir, { recursive: true });
  supervise();
} else { console.error('usage: serve.mjs run|status|stop [--port=N]'); process.exit(2); }

function supervise() {
  const log = (m) => { const l = `${new Date().toISOString()} [serve:${PORT}] ${m}\n`; appendFileSync(LOG, l); process.stdout.write(l); };
  const fingerprint = () => {
    let newest = 0, count = 0;
    const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else { try { const s = statSync(p); count++; if (s.mtimeMs > newest) newest = s.mtimeMs; } catch { /* best effort */ } } } };
    walk(dist);
    let em = 0, es = 0; try { const s = statSync(entry); em = s.mtimeMs; es = s.size; } catch { /* best effort */ }
    return `${em}:${es}:${newest}:${count}`;
  };
  let child = null, running = null, lastSeen = null, changedAt = Date.now(), stopping = false, busy = false;
  const stopChild = () => new Promise((res) => {
    if (!child) return res();
    const c = child; child = null;
    const t = setTimeout(() => { log(`SIGKILL child ${c.pid} (no exit in 10s)`); try { c.kill('SIGKILL'); } catch { /* best effort */ } }, 10000);
    c.once('exit', () => { clearTimeout(t); res(); });
    try { c.kill('SIGTERM'); } catch { clearTimeout(t); res(); }
  });
  const start = (fp) => {
    const env = { ...process.env, ADHD_AGENT_TRANSPORT: 'http', ADHD_AGENT_PORT: String(PORT) };
    env.ADHD_AGENT_SSE_HOST ??= '127.0.0.1';
    const c = spawn(process.execPath, [entry], { cwd: workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = (d) => { try { appendFileSync(LOG, d); } catch { /* best effort */ } process.stdout.write(d); };
    c.stdout.on('data', sink); c.stderr.on('data', sink);
    c.on('exit', (code, sig) => { log(`child ${c.pid} exited code=${code} signal=${sig}`); if (child === c) child = null; });
    child = c; running = fp; log(`started server pid=${c.pid} url=${url} dist=${dist}`);
  };
  const tick = async () => {
    if (busy || stopping) return; busy = true;
    try {
      if (!existsSync(entry) || !existsSync(pkg)) { if (lastSeen !== 'missing') log(`waiting for built dist (${entry} + package.json); this target never builds`); lastSeen = 'missing'; changedAt = Date.now(); return; }
      const f = fingerprint();
      if (f !== lastSeen) { if (lastSeen && lastSeen !== 'missing') log('dist change detected; waiting for it to settle'); lastSeen = f; changedAt = Date.now(); return; }
      if (Date.now() - changedAt < STABLE) return;
      if (f !== running || !child) {
        if (child) { log(`reload: SIGTERM server ${child.pid}`); await stopChild(); }
        start(f);
      }
    } finally { busy = false; }
  };
  const shutdown = async (sig) => { if (stopping) return; stopping = true; log(`received ${sig}; stopping server`); await stopChild(); try { unlinkSync(PIDF); } catch { /* best effort */ } process.exit(0); };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  writeFileSync(PIDF, String(process.pid));
  log(`supervisor pid=${process.pid} watching ${dist} stable=${STABLE}ms poll=${POLL}ms`);
  setInterval(tick, POLL); tick();
}
