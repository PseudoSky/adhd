#!/usr/bin/env node
/**
 * bin/cli.ts: the `stealth-search` CLI. The Node >= 22.5 preflight runs first and the host graph is
 * loaded only after it passed (a `require`, so no import is hoisted above the check; the core and
 * the apigen packages need a modern runtime and would otherwise fail with an unreadable import
 * error). A runtime below 22.5 ends with the typed code NODE_TOO_OLD: one stderr line and exit 12.
 * Telemetry starts once, before the first dispatch, through `src/telemetry.js`.
 *
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.9] [search-hosts.15]
 */

export {}

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)

if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
  process.stderr.write(`NODE_TOO_OLD: Node.js ${process.versions.node} is too old; stealth-search needs Node.js 22.5 or newer\n`)
  process.exitCode = 12
} else {
  const { runCli } = require('../src/cli.js') as typeof import('../src/cli')
  const { initSearchTelemetry } = require('../src/telemetry.js') as typeof import('../src/telemetry')
  void runCli(process.argv.slice(2), { initTelemetry: initSearchTelemetry })
}
