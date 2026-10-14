import { startPolicyMcp } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';
import { installAbortOnSignals } from '../wrapper/signals';

await runEntry(() => startPolicyMcp({ signal: installAbortOnSignals() }));
