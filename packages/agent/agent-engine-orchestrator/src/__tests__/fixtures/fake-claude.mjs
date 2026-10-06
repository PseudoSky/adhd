#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`, used by
// nat-tool-3-cwd-env.e2e.test.ts (ADR-0008 D9 / NAT-TOOL-3).
//
// The REAL ClaudeCliProvider spawns this script with whatever `cwd` and env it
// configures. The script then:
//   1. records its OWN process.cwd() (proves the provider's spawn cwd), and
//   2. reads the `--mcp-config` the provider wrote, and launches each stdio
//      server from it WITHOUT an explicit cwd — exactly as Claude Code launches
//      its MCP children — so the child inherits this process's cwd. The child
//      (cwd-env-server.mjs, report mode) writes its cwd to a file, proving the
//      configured cwd reached the MCP child transitively.
// Finally it emits a valid stream-json `result` event so provider.chat()
// resolves. Nothing here speaks to a real model.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const mcpConfigPath = flag('--mcp-config');
const selfOut = process.env.ADHD_FAKE_CLAUDE_OUT;
const childReport = process.env.ADHD_FAKE_CLAUDE_CHILD_REPORT;

const record = { cwd: process.cwd(), mcpConfigPath, mcpConfig: undefined };

process.stdin.resume();
process.stdin.once('data', async () => {
  if (mcpConfigPath) {
    record.mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));

    for (const [name, entry] of Object.entries(record.mcpConfig.mcpServers ?? {})) {
      if (entry.type !== 'stdio') continue;
      await new Promise((resolve) => {
        const child = spawn(entry.command, entry.args ?? [], {
          // No explicit cwd: inherit this process's cwd, as Claude Code does.
          env: {
            ...process.env,
            ...(entry.env ?? {}),
            ...(childReport
              ? { ADHD_CWD_REPORT_FILE: childReport, ADHD_CWD_REPORT_NAME: name }
              : {}),
          },
          stdio: 'ignore',
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      });
    }
  }

  if (selfOut) writeFileSync(selfOut, JSON.stringify(record));
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }) + '\n',
    // Exit only after the line is fully flushed, so readline in the provider
    // never misses it (process.exit can otherwise truncate a pipe write).
    () => process.exit(0)
  );
});
