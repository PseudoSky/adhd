import { runPolicyCli } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';

await runEntry(() => runPolicyCli(process.argv.slice(2)));
