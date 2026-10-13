import { startPolicyHttp } from '../wrapper/mount';
import { installAbortOnSignals } from '../wrapper/signals';

// ADHD_POLICY_HTTP_PORT is a port setting; 0 asks the OS for an ephemeral port.
const port = Number(process.env['ADHD_POLICY_HTTP_PORT'] ?? 0);

await startPolicyHttp({ signal: installAbortOnSignals(), host: '127.0.0.1', port });
