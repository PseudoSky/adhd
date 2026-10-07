/**
 * membership-backfill.guard.spec.ts — e54bd58b A-AC5: the runner's pure helpers.
 * The runner opens the database directly (bypassing the transport-level
 * `assertProductionWriteAllowed`), so its own production-path guard and argv
 * contract are asserted here; the process-level exit codes are in
 * `membership-backfill-runner.e2e.ts`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProductionPath, parseArgs, productionStoreRoot } from '../../tools/migrate/membership-backfill.js';

describe('e54bd58b A-AC5 membership-backfill runner guard', () => {
  const home = '/home/someone';
  it('e54bd58b A-AC5 flags paths under ~/.adhd/backlog/production and nothing else', () => {
    expect(productionStoreRoot(home)).toBe(join(home, '.adhd/backlog/production'));
    expect(isProductionPath(join(home, '.adhd/backlog/production/backlog-v2.db'), home)).toBe(true);
    expect(isProductionPath(join(home, '.adhd/backlog/production/../sandbox/x.db'), home)).toBe(false);
    expect(isProductionPath(join(home, '.adhd/backlog/production-copy/x.db'), home)).toBe(false);
    expect(isProductionPath('/tmp/rehearsal/backlog-v2.db', home)).toBe(false);
  });

  it('e54bd58b A-AC5 argv: dry-run default, --apply, --reverse <journal>, --allow-production-write', () => {
    expect(parseArgs(['x.db'])).toMatchObject({ dbPath: 'x.db', mode: 'dry-run', allowProduction: false });
    expect(parseArgs(['x.db', '--apply', '--allow-production-write'])).toMatchObject({
      mode: 'apply',
      allowProduction: true,
    });
    expect(parseArgs(['x.db', '--reverse', 'j.json'])).toMatchObject({ mode: 'reverse', journalPath: 'j.json' });
  });
});
