/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the sibling
 * `testing-record.e2e.ts`.
 *
 * It spawns the built dist/index.js, so it runs in the `e2e` lane. This file spawns nothing;
 * it exists so the default `test` target has the file's contract in view.
 *
 * guards: the Testing record grammar the e2e proves is also listed in the unit lane, so the suite is not invisible there.
 * tier: S
 * cites: 595965cc T35.AC1-AC4
 * teeth: none (placeholder todos; the red evidence is the e2e file's)
 *
 * skip-expiry: 595965cc until 2026-12-31 the mocked placeholders are covered by testing-record.e2e.ts in the e2e lane.
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { describe, it } from 'vitest';

describe('mocked: testing-record', () => {
  it.todo('mocked: SKILL.md documents the Testing record grammar (8 change-classes, 7 fields)');
  it.todo('mocked: a record created through the CLI is read back unchanged through get and query');
  it.todo('mocked: the regression-test evidence obligation is accepted and stored');
  it.todo('mocked: an exception item carries an expires line and a relates_to relation');
});
