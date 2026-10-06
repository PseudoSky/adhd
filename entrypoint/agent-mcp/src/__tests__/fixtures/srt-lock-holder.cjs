'use strict';
// srt-lock-holder.cjs — a SEPARATE-PROCESS concurrent provisioner used by
// srt-policy.e2e.test.ts to prove `provisionSrtPolicy`'s read-modify-write is
// serialized by the lock (ADR-0012; finding 535c1101). It:
//   1. acquires the SAME lock file `provisionSrtPolicy` uses (`<path>.lock`);
//   2. signals readiness (`.ready`);
//   3. waits for the driver's `.go`;
//   4. holds for a moment, then writes its own rule DIRECTLY (simulating what a
//      concurrent provisioner does inside its critical section);
//   5. releases the lock.
// A lock-less `provisionSrtPolicy` in the driver would read stale and overwrite,
// losing whichever rule landed last (deterministic revert-failing tooth).
const { existsSync, rmSync, writeFileSync } = require('node:fs');

const settingsPath = JSON.parse(process.argv[2]).settingsPath;
const lock = `${settingsPath}.lock`;
const ready = `${settingsPath}.ready`;
const go = `${settingsPath}.go`;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  writeFileSync(lock, 'held', { flag: 'wx' });
} catch {
  process.exit(3); // lock already held — the driver mis-set the test up
}
writeFileSync(ready, '1');

const deadline = Date.now() + 5000;
while (!existsSync(go)) {
  if (Date.now() > deadline) {
    rmSync(lock, { force: true });
    process.exit(4);
  }
  sleep(5);
}

// Hold so a lock-less driver would have read the pre-write state, then land our
// rule and release. With the lock, the driver cannot enter until we are done.
sleep(250);
writeFileSync(settingsPath, JSON.stringify({ filesystem: { allowWrite: ['/child'] } }));
rmSync(lock, { force: true });
rmSync(ready, { force: true });
rmSync(go, { force: true });
