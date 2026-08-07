#!/usr/bin/env node
// BUG-APIGEN-053 regression harness. Spawns EXACTLY the given argv, forwards
// the child's stdout/stderr (prefixed) so a caller can observe readiness,
// prints the child's PID as this process's OWN first stdout line, then hangs
// forever -- and NEVER sends the child any signal, ever, for any reason.
// A caller SIGKILLs THIS process (never the child) to reproduce "the TS
// parent that spawned the Python server died outright" without touching the
// grandchild at all -- isolating whether the grandchild's OWN stdin-EOF
// watchdog (apigen_python.parent_watchdog) is what saves it.
import { spawn } from 'node:child_process';

const [, , command, ...args] = process.argv;
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
console.log(JSON.stringify({ childPid: child.pid }));
child.stdout.on('data', (c) => process.stdout.write(`[child stdout] ${c}`));
child.stderr.on('data', (c) => process.stderr.write(`[child stderr] ${c}`));
// No signal forwarding, no exit handling for the child -- this process must
// do NOTHING on its own death besides simply dying, which SIGKILL does
// regardless of any handler anyway.
// eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberately never resolves; this process must hang until the test harness SIGKILLs it
await new Promise(() => {});
