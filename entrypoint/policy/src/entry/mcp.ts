import { startPolicyMcp } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';
import { installAbortOnSignals } from '../wrapper/signals';

void runEntry(() => startPolicyMcp({ signal: installAbortOnSignals() }));
