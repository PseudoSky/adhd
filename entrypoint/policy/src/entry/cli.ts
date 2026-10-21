import { runPolicyCli } from '../wrapper/mount';
import { runEntry } from '../wrapper/run-entry';

runEntry(() => runPolicyCli(process.argv.slice(2))).catch((error: unknown) => {
  process.stderr.write(`adhd-policy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
