import { runPolicyCli } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';

void runEntry(() => runPolicyCli(process.argv.slice(2)));
