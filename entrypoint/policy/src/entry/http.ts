import { startPolicyHttp } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';
import { installAbortOnSignals } from '../wrapper/signals';

// The port comes from ADHD_POLICY_HTTP_PORT (parsed strictly in the mount; 0 asks the OS for an ephemeral port).
void runEntry(() => startPolicyHttp({ signal: installAbortOnSignals(), host: '127.0.0.1' }));
