/**
 * cli.optional-input.e2e.ts — a verb whose input is entirely optional runs
 * with NO `--input` flag, while a verb with a required field still rejects a
 * missing `--input`.
 *
 * Failure mode: `priorityMatrix`/`report`/`query` declared `input: I…` with no
 * default, so `@adhd/apigen-core-client` marked `input` a required key of the
 * `data` envelope and every bare `backlog query` exited 2 with
 * `missing required key 'input' at data`. RED: with the required parameter
 * restored, the three "runs with no --input" cases fail with exit 2. GREEN:
 * the parameters carry a `= {}` default, the extractor marks them optional,
 * and the three verbs exit 0 with an `ok:true` envelope. The `get` case is the
 * negative control: `get` requires `uid`, so it must keep rejecting a bare call.
 *
 * Also asserts stderr carries no per-call apigen trace (`→ <command>`), which
 * covers the sox-routed CLI logger.
 *
 * Lane: subprocess → `*.e2e.ts` (docs/decisions/0009). Spawns the REAL built
 * `dist/index.js` (`dependsOn: ["build"]`) through the shared
 * `runBacklogBin` helper, which pins `--namespace sandbox` so nothing touches
 * the real production store. Every sandbox the CLI mints is tracked and
 * removed in `afterAll`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  extractMintedSandboxRoot,
  looksLikeOwnSandboxDir,
  runBacklogBin,
} from './test/helpers/spawn-backlog-bin.js';

const minted: string[] = [];

afterAll(() => {
  for (const root of minted) {
    if (looksLikeOwnSandboxDir(root)) rmSync(root, { recursive: true, force: true });
  }
});

/** The envelope is the one line that starts with `{`; the sandbox notice precedes it on stderr. */
function envelopeLine(text: string): unknown {
  const line = text.split('\n').find((l) => l.startsWith('{'));
  if (line === undefined) throw new Error(`no JSON envelope in: ${text}`);
  return JSON.parse(line);
}

function run(args: string[]) {
  const r = runBacklogBin(args);
  const root = extractMintedSandboxRoot(r.stderr);
  if (root !== undefined) minted.push(root);
  return r;
}

describe('optional-input verbs run without --input (real built CLI)', () => {
  it.each(['priority-matrix', 'report', 'query', 'open-curve', 'timeline'])(
    '%s with no --input exits 0 with an ok:true envelope and no per-call trace on stderr',
    (verb) => {
      const r = run([verb]);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('→ ');
      expect((envelopeLine(r.stdout) as { ok: boolean }).ok).toBe(true);
    }
  );

  it('negative control: get (required uid) with no --input still exits 2 invalid_argument', () => {
    const r = run(['get']);
    expect(r.status).toBe(2);
    expect((envelopeLine(r.stdout || r.stderr) as { code: string }).code).toBe('invalid_argument');
  });
});
