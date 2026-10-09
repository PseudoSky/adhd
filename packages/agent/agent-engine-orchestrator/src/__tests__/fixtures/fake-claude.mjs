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
// ADHD_FAKE_CLAUDE_HOLD (backlog 322a1efb) models a real `claude` that is still
// flushing its session after the `result` line:
//   "1"      block exit until BOTH stdin EOF (the provider closes stdin) AND a
//            SIGUSR2 latch from the test; then process.exit(0). Any other signal
//            (e.g. the provider's SIGTERM) kills it, so a premature kill is visible
//            as spawn.exit {signal:"SIGTERM"}.
//   "no-result" never emits a `result` line and never exits on its own (models a
//            hung/aborted turn; only a provider signal ends it).
//   "ignore" never exit: ignore stdin EOF and SIGTERM (and SIGUSR2), and spawn a
//            grandchild in the same process group (pid written to
//            ADHD_FAKE_CLAUDE_GRANDCHILD_PID_FILE) that also ignores SIGTERM. Only
//            the provider's group SIGKILL reaps it.
// Finally it emits a valid stream-json `result` event so provider.chat()
// resolves. Nothing here speaks to a real model.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function noop() {
  /* intentionally empty: keepalive / ignored-signal handler */
}

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
  if (process.env.ADHD_FAKE_CLAUDE_HOLD === 'no-result') {
    setInterval(noop, 1e6); // never answers: only a signal from the provider ends it
    return;
  }
  if (mcpConfigPath) {
    // The provider passes a file path when it has MCP servers, inline JSON otherwise.
    record.mcpConfig = JSON.parse(
      mcpConfigPath.trimStart().startsWith('{') ? mcpConfigPath : readFileSync(mcpConfigPath, 'utf8')
    );

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
  const hold = process.env.ADHD_FAKE_CLAUDE_HOLD;
  if (hold === 'ignore') {
    process.on('SIGTERM', noop);
    process.on('SIGUSR2', noop);
    const gc = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1e6)"],
      { stdio: 'ignore' } // same process group as this process (not detached)
    );
    if (process.env.ADHD_FAKE_CLAUDE_GRANDCHILD_PID_FILE) {
      writeFileSync(process.env.ADHD_FAKE_CLAUDE_GRANDCHILD_PID_FILE, String(gc.pid));
    }
    setInterval(noop, 1e6); // keep the event loop alive forever
  }
  let exitAfterFlush = () => process.exit(0);
  if (hold === '1') {
    let eof = false;
    let latch = false;
    const maybeExit = () => {
      if (eof && latch) process.exit(0);
    };
    process.stdin.once('end', () => { eof = true; maybeExit(); });
    process.on('SIGUSR2', () => { latch = true; maybeExit(); });
    setInterval(noop, 1e6); // stay alive (stdin is at EOF) until released
    exitAfterFlush = noop;
  } else if (hold === 'ignore') {
    exitAfterFlush = noop;
  }
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }) + '\n',
    // Exit only after the line is fully flushed, so readline in the provider
    // never misses it (process.exit can otherwise truncate a pipe write).
    exitAfterFlush
  );
});
