#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` that FAILS on purpose (9ed453c1 / de6bee5d FLT).
// Every invocation appends one line to ADHD_FAKE_CLAUDE_COUNT_FILE (invocation counter).
// ADHD_FAKE_CLAUDE_FAULT:
//   window    synthetic `rejected` five_hour rate_limit_event + is_error result, exit 1
//             (SYNTHETIC: shape per the claude 2.1.296 schema; a live rejected event was never captured)
//   exit3     writes "boom: config unreadable" to stderr and exits 3 with no stdout
//   hang      writes its pid + a same-group grandchild pid to ADHD_FAKE_CLAUDE_PID_FILE, then never answers
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

function noop() {
  /* keepalive */
}

appendFileSync(process.env.ADHD_FAKE_CLAUDE_COUNT_FILE, 'x\n');
const fault = process.env.ADHD_FAKE_CLAUDE_FAULT;
const resetsAt = Number(process.env.ADHD_FAKE_CLAUDE_RESETS_AT ?? '0');

process.stdin.resume();
process.stdin.once('data', () => {
  if (fault === 'window') {
    process.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "5-hour limit reached ∙ resets 3pm" }) + '\n', () => process.exit(1));
    return;
  }
  if (fault === 'exit3') {
    process.stderr.write('boom: config unreadable\n', () => process.exit(3));
    return;
  }
  // hang
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
  writeFileSync(process.env.ADHD_FAKE_CLAUDE_PID_FILE, JSON.stringify({ child: process.pid, grandchild: gc.pid }));
  setInterval(noop, 1e6);
});
