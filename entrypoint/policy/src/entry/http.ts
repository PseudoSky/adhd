import { startPolicyHttp } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';
import { installAbortOnSignals } from '../wrapper/signals';

// The port comes from ADHD_POLICY_HTTP_PORT (parsed strictly in the mount; 0 asks the OS for an ephemeral port).
runEntry(() => startPolicyHttp({ signal: installAbortOnSignals(), host: '127.0.0.1' })).catch((error: unknown) => {
  process.stderr.write(`adhd-policy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
