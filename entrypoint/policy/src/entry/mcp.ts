import { startPolicyMcp } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';
import { installAbortOnSignals } from '../wrapper/signals';

runEntry(() => startPolicyMcp({ signal: installAbortOnSignals() })).catch((error: unknown) => {
  process.stderr.write(`adhd-policy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
