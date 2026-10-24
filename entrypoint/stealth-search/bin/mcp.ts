#!/usr/bin/env node
/**
 * bin/mcp.ts: the `stealth-search-mcp` server. The Node >= 22.5 preflight runs first and the host
 * graph is loaded only after it passed (a `require`, so no import is hoisted above the check). A
 * runtime below 22.5 ends with the typed code NODE_TOO_OLD: one stderr line and exit 12. Telemetry
 * starts once, before the first dispatch, through `src/telemetry.js`. A failed boot applies its
 * exit status here; a started server ends through the core exit hooks.
 *
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.9] [search-hosts.12] [search-hosts.15]
 */

export {}

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number)

if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
  process.stderr.write(`NODE_TOO_OLD: Node.js ${process.versions.node} is too old; stealth-search needs Node.js 22.5 or newer\n`)
  process.exitCode = 12
} else {
  const { mcpMain } = require('../src/server.js') as typeof import('../src/server')
  const { initSearchTelemetry } = require('../src/telemetry.js') as typeof import('../src/telemetry')
  void mcpMain(process.argv.slice(2), { initTelemetry: initSearchTelemetry }).then(
    (code) => {
      process.exitCode = code
    },
    (e: unknown) => {
      // mcpMain does not reject; if it ever does, end with one typed line instead of an unhandled rejection.
      process.stderr.write(`HOST_BOOT_FAILED: ${(e instanceof Error ? e.message : String(e)).replace(/\s*\r?\n\s*/g, ' ')}\n`)
      process.exitCode = 79
    },
  )
}
