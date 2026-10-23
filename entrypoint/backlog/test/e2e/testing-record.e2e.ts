/**
 * testing-record.e2e.ts — 595965cc T35: the `## Testing record` body convention round-trips
 * through the REAL built `dist/index.js` and survives a store reopen.
 *
 * The convention is documented in `skill/SKILL.md`; the backlog schema is not changed
 * (T35.AC5, checked by `git diff --name-only` over `src/` excluding tests). This file proves:
 *
 *  - T35.AC1 `SKILL.md` documents the grammar: the eight `change-class` values, `rigor`,
 *    `triggers`, `ac:`, `not-testing:`, `plan:`, `expires:`.
 *  - T35.AC2 An item created through the CLI with the record is read back byte-for-byte through
 *    `get` and `query`, from a NEW process (each CLI call is one) after the store was closed.
 *  - T35.AC3 The documented regression-test evidence obligation (existing `evidence` kind,
 *    warn-level) is accepted by `obligate` and read back through `get`.
 *  - T35.AC4 An exception is an ordinary item: its body carries `expires:` and a `relates_to`
 *    relation to the item it excuses, both read back.
 *
 * guards: a Testing record written through the CLI is lost, altered or unreadable after a store reopen
 * tier: P
 * gap: cannot be observed at tier S because the claim is about the built dist/index.js, a fresh process per call and a reopened store
 * cites: 595965cc T35.AC1-AC4
 * teeth: red when `get`/`query` return a body that differs from the one written, or when `obligate`/`relate` reject the documented shapes
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from '../../src/test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');
const SKILL = readFileSync(join(HERE, '..', '..', 'skill', 'SKILL.md'), 'utf8');

const CHANGE_CLASSES = [
  'new-behavior',
  'defect-fix',
  'refactor',
  'configuration',
  'dependency',
  'boundary-contract',
  'no-code',
  'test-maintenance',
];

const RECORD = [
  '## Testing record',
  'change-class: defect-fix',
  'rigor: standard',
  'triggers: persistence',
  'ac: AC1 a deleted row stays deleted after reopen ; AC2 a repeated delete is a no-op',
  'not-testing: concurrent writers, covered by the store lane',
  'plan: row survives reopen → H → AC1',
].join('\n');
const BODY = `Why and where.\n\n${RECORD}\n`;

const PROJECT = 'testing-record-demo';
let tmpRoot: string;
let dbPath: string;
let uid: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBin(args: string[]): Run {
  return runIsolatedBin(DIST_INDEX, args, tmpRoot, { extraEnv: { ADHD_BACKLOG_DATABASE_PATH: dbPath } });
}

function okData(args: string[]): Record<string, unknown> {
  const r = runBin(args);
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  const body = JSON.parse(line) as { ok?: boolean; data?: Record<string, unknown> };
  expect(r.status, `${args.join(' ')}: ${r.stdout}${r.stderr}`).toBe(0);
  expect(body.ok, `${args.join(' ')}: ${line}`).toBe(true);
  return body.data as Record<string, unknown>;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-testing-record-'));
  dbPath = join(tmpRoot, 'tr.db');
  okData(['upsert-project', '--input', JSON.stringify({ name: PROJECT, by: 'testing-record.e2e' })]);
  uid = okData([
    'create',
    '--input',
    JSON.stringify({ title: 'record carrier', body: BODY, project: PROJECT, by: 'testing-record.e2e', duplicateAction: 'force' }),
  ])['uid'] as string;
}, 120_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('595965cc T35 — the testing-record convention', () => {
  it('595965cc T35.AC1 SKILL.md documents the grammar: every change-class and every record field', () => {
    for (const c of CHANGE_CLASSES) expect(SKILL, c).toContain(c);
    for (const field of ['## Testing record', 'change-class:', 'rigor:', 'triggers:', 'ac:', 'not-testing:', 'plan:', 'expires:']) {
      expect(SKILL, field).toContain(field);
    }
  });

  it('595965cc T35.AC2 the record is read back unchanged through get, from a new process', () => {
    const data = okData(['get', '--input', JSON.stringify({ uid, fields: ['body'] })]);
    expect(data['body']).toBe(BODY);
  });

  it('595965cc T35.AC2 the record is read back unchanged through query', () => {
    const data = okData([
      'query',
      '--input',
      JSON.stringify({ filter: { project: PROJECT }, fields: ['uid', 'body'], limit: 10 }),
    ]);
    const items = data['items'] as Array<{ uid: string; body?: string }>;
    const found = items.find((i) => i.uid === uid);
    expect(found?.body).toBe(BODY);
  });

  it('595965cc T35.AC3 the documented regression-test evidence obligation is accepted and stored', () => {
    okData([
      'obligate',
      '--input',
      JSON.stringify({
        uid,
        by: 'testing-record.e2e',
        applies_to: { to: 'done' },
        requirement: { op: 'evidence', kind: 'regression-test' },
        on_fail: 'warn',
      }),
    ]);
    const data = okData(['get', '--input', JSON.stringify({ uid, fields: ['obligations'] })]);
    const obligations = data['obligations'] as Array<{ requirement: { op: string; kind: string }; on_fail: string }>;
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.requirement).toEqual({ op: 'evidence', kind: 'regression-test' });
    expect(obligations[0]?.on_fail).toBe('warn');
  });

  it('595965cc T35.AC4 an exception is an ordinary item: expires line in the body, relates_to the item it excuses', () => {
    const exceptionBody = ['Exception for the carrier.', '', '## Testing record', 'change-class: test-maintenance', 'rigor: light', 'triggers: none', 'ac: AC1 excused until fixed', 'not-testing: none', 'plan: n/a', 'expires: 2026-12-31'].join('\n');
    const exc = okData([
      'create',
      '--input',
      JSON.stringify({ title: 'exception for record carrier', body: exceptionBody, project: PROJECT, by: 'testing-record.e2e', duplicateAction: 'force' }),
    ])['uid'] as string;
    okData([
      'relate',
      '--input',
      JSON.stringify({ sourceUid: exc, targetUid: uid, rel: 'relates_to', action: 'add', by: 'testing-record.e2e' }),
    ]);
    const got = okData(['get', '--input', JSON.stringify({ uid: exc, fields: ['body', 'related'] })]);
    expect(String(got['body'])).toMatch(/^expires: 2026-12-31$/m);
    expect(JSON.stringify(got['related'])).toContain(uid);
  });
});
