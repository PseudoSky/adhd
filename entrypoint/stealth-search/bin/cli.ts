#!/usr/bin/env node
/**
 * bin/cli.ts: `stealth-search` CLI host entry. The command surface is mounted by
 * the search-hosts state; until then the shell reports that it is not wired.
 */
process.stderr.write('stealth-search: CLI host is not wired yet\n');
process.exitCode = 1;
