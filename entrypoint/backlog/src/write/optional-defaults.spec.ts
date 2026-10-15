/**
 * optional-defaults.spec.ts — the four semantically-defaultable inputs are
 * optional, resolve to the documented default against a REAL store, and keep
 * their validation for explicit values.
 *
 *   - `openCurve.at`        omitted ⇒ one sample at the current instant
 *   - `claim.action`        omitted ⇒ `'claim'`
 *   - `relate.action`       omitted ⇒ `'add'`
 *   - `obligate.on_fail`    omitted ⇒ `'block'` (the strict severity)
 *
 * Failure mode: each key was REQUIRED in its input type, so a caller who
 * omitted it hit a validation error (or a TypeError) even though the verb has
 * one obvious meaning for the omitted case. RED: with the defaults removed,
 * the "omitted" cases fail. GREEN: the omitted case resolves to the documented
 * default and the explicit/invalid cases keep their original behaviour.
 *
 * Tier: unit (default `test` lane) — in-process against a real store
 * (`openTestIssueStore`), no subprocess, no embedding model.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openTestIssueStore,
  removeTestIssueStoreDir,
  seedProject,
  type TestIssueStore,
} from '../test/helpers/open-test-issue-store.js';
import { freshTmpDir } from '../test/helpers/tmp-store.js';
import { getIssue } from '../query/get.js';
import { openCurve } from '../query/views/stats.js';
import { createIssue } from './create-issue.js';
import { claim, type IClaimInput } from './claim.js';
import { relate, type IRelateInput } from './relate.js';
import { obligate, type IObligateInput } from './obligation.js';
import { InvalidArgumentError } from './errors.js';

describe('optional inputs resolve their documented defaults (real store)', () => {
  let dir: string;
  let store: TestIssueStore;
  let projectUid: string;

  beforeEach(async () => {
    dir = freshTmpDir('optional-defaults');
    store = await openTestIssueStore(join(dir, 'backlog.db'));
    projectUid = (await seedProject(store, 'optional-defaults-project')).projectUid;
  });

  afterEach(async () => {
    await store.close();
    removeTestIssueStoreDir(dir);
  });

  async function newIssue(title: string): Promise<string> {
    const created = await createIssue(store, {
      project: projectUid,
      title,
      body: `body for ${title}`,
      by: 'filer',
    });
    if (created.uid === undefined)
      throw new Error('setup: createIssue returned no uid');
    return created.uid;
  }

  describe('open-curve: at', () => {
    it('omitted ⇒ a single sample at the current instant', async () => {
      await newIssue('curve subject');
      const before = Date.now();
      const result = await openCurve(store, {});
      const after = Date.now();

      expect(result.points).toHaveLength(1);
      const sampled = Date.parse(result.points[0]!.at);
      expect(Number.isNaN(sampled)).toBe(false);
      expect(sampled).toBeGreaterThanOrEqual(before - 1000);
      expect(sampled).toBeLessThanOrEqual(after + 1000);
    });

    it('an explicit empty list is still rejected (only omission defaults)', async () => {
      await expect(openCurve(store, { at: [] })).rejects.toBeInstanceOf(
        InvalidArgumentError
      );
    });
  });

  describe('claim: action', () => {
    it('omitted ⇒ claims the issue (status "claimed")', async () => {
      const uid = await newIssue('claim target');
      const outcome = await claim(store, { uid, by: 'agent-a' });

      expect(outcome.status).toBe('claimed');
      expect(outcome.claimedBy).toBe('agent-a');
    });

    it('an out-of-vocabulary explicit action is still rejected', async () => {
      const uid = await newIssue('claim target bad action');
      await expect(
        claim(store, {
          uid,
          by: 'agent-a',
          action: 'bogus' as unknown as IClaimInput['action'],
        })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  describe('relate: action', () => {
    it('omitted ⇒ adds the edge (outcome.action "add")', async () => {
      const a = await newIssue('relate source');
      const b = await newIssue('relate target');
      const outcome = await relate(store, {
        sourceUid: a,
        targetUid: b,
        rel: 'relates_to',
        by: 'agent-a',
      });

      expect(outcome.action).toBe('add');
      expect(outcome.noop).toBe(false);
    });

    it('an out-of-vocabulary explicit action is still rejected', async () => {
      const a = await newIssue('relate source bad');
      const b = await newIssue('relate target bad');
      await expect(
        relate(store, {
          sourceUid: a,
          targetUid: b,
          rel: 'relates_to',
          action: 'bogus' as unknown as IRelateInput['action'],
          by: 'agent-a',
        })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  describe('obligate: on_fail', () => {
    it('omitted ⇒ persists the strict severity "block"', async () => {
      const uid = await newIssue('obligation subject');
      await obligate(store, {
        uid,
        applies_to: { to: 'RESOLVED' },
        requirement: { op: 'blockers_terminal' },
        by: 'declarer:1',
      });

      const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
      expect(card.obligations).toHaveLength(1);
      expect(card.obligations![0]!.on_fail).toBe('block');
    });

    it('an explicit "warn" is preserved, not overridden by the default', async () => {
      const uid = await newIssue('obligation warn subject');
      await obligate(store, {
        uid,
        applies_to: { to: 'RESOLVED' },
        requirement: { op: 'blockers_terminal' },
        on_fail: 'warn',
        by: 'declarer:1',
      });

      const card = await getIssue(store.graph, { uid, fields: ['obligations'] });
      expect(card.obligations![0]!.on_fail).toBe('warn');
    });

    it('an out-of-vocabulary explicit on_fail is still rejected', async () => {
      const uid = await newIssue('obligation bad severity');
      await expect(
        obligate(store, {
          uid,
          applies_to: { to: 'RESOLVED' },
          requirement: { op: 'blockers_terminal' },
          on_fail: 'bogus' as unknown as IObligateInput['on_fail'],
          by: 'declarer:1',
        })
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });
});
