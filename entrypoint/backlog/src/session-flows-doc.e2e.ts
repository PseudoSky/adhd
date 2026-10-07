/**
 * session-flows-doc.e2e.ts — 91a8c640 B-AC8: the evidence embedded in
 * `docs/plan/backlog-consolidation/session-flows.md` equals a FRESH drive of three
 * real agent flows through the built bin (isolated sandbox store, never production).
 *
 * Resource lane: spawns the built bin per call. Static half: `session-flows-doc.spec.ts`.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { driveSessionFlows } from './test/helpers/session-flows-driver.js';
import { parseDoc, toEvidence } from './test/helpers/session-flows-evidence.js';
import { e2eTestTimeoutMs } from './test/helpers/spawn-timeout.js';

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'plan', 'backlog-consolidation', 'session-flows.md');

describe('91a8c640 B-AC8 — session-flows.md evidence re-derived from the built bin', () => {
  it(
    'a fresh drive reproduces the documented evidence, and every cited session id resolves via timeline',
    () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sf-doc-e2e-')));
      const result = driveSessionFlows(scratch);
      try {
        const doc = parseDoc(readFileSync(DOC, 'utf8'));
        expect(toEvidence(result)).toEqual(doc.evidence);
        for (const f of result.flows) expect(f.timeline.session.sessionId).toBe(f.sessionId);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
        rmSync(result.sandbox.adhdRoot, { recursive: true, force: true });
      }
    },
    e2eTestTimeoutMs(40)
  );
});
