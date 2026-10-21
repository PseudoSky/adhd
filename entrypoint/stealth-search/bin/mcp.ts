#!/usr/bin/env node
/**
 * bin/mcp.ts: `stealth-search-mcp` MCP host entry. The tool surface is mounted by
 * the search-hosts state; until then the shell reports that it is not wired.
 */
process.stderr.write('stealth-search-mcp: MCP host is not wired yet\n');
process.exitCode = 1;
