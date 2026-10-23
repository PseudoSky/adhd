import { reportFailure } from './verbs/failure';

/**
 * Runs a long-lived entry (`adhd-policy-mcp`, `adhd-policy-http`) and turns a
 * start-up failure into one stderr line and the exit code `CLI_EXIT_CODE`
 * assigns it (invalid input 2, anything else 1) instead of an uncaught
 * rejection with a stack trace.
 */
export async function runEntry(start: () => Promise<void>): Promise<void> {
  try {
    await start();
  } catch (error) {
    process.exitCode = reportFailure(error, { stderr: (text) => void process.stderr.write(text) });
  }
}
