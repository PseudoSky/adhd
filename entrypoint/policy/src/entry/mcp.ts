import { startPolicyMcp } from '../wrapper/mount';
import { installAbortOnSignals } from '../wrapper/signals';

await startPolicyMcp({ signal: installAbortOnSignals() });
