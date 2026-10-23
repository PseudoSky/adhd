// Dry-run safety net, loaded into the agent-mcp server (and its node children) via NODE_OPTIONS=--require.
// Any TCP connect to a non-loopback host is refused and logged to $R2_EGRESS_LOG. This makes "the dry-run makes no
// real network call" enforced rather than merely intended.
const net = require('node:net');
const fs = require('node:fs');
const orig = net.Socket.prototype.connect;
const LOOP = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', undefined]);
// The server provisions its pinned shell MCP server through pip/uvx (a package index, never a model endpoint); that is real,
// needed setup and is allowed. Every other non-loopback host is refused.
const ALLOW = new Set(['pypi.org', 'files.pythonhosted.org']);
net.Socket.prototype.connect = function patched(...args) {
  let o = args[0], host;
  if (typeof o === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost';
  else if (o && typeof o === 'object') host = o.path ? undefined : (o.host ?? 'localhost');
  else if (typeof o === 'string') host = undefined;                                  // unix socket path
  if (Array.isArray(o)) { o = o[0]; host = o && o.host; }
  if (!LOOP.has(host) && !ALLOW.has(host)) {
    try { if (process.env.R2_EGRESS_LOG) fs.appendFileSync(process.env.R2_EGRESS_LOG, `${new Date().toISOString()} BLOCKED ${host}\n`); } catch { /* ignore */ }
    const e = new Error(`R2 DRY-RUN EGRESS BLOCKED: ${host}`); e.code = 'ECONNREFUSED';
    process.nextTick(() => this.destroy(e)); return this;
  }
  return orig.apply(this, args);
};
