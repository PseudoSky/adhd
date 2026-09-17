/**
 * search-shortcut-wire.spec.ts — `backlog search --plan`/`--project-path`
 * proven AT THE WIRE, through the REAL BUILT `dist/index.js`.
 *
 * ## The defect this exists to catch
 *
 * `search-shortcut.ts` compiled five CLI flags (`--repo`, `--plan`, `--tag`,
 * `--project-path`, `--family`) to `filter` keys that `IIssueFilter`
 * (query/types.ts) did not declare. The apigen-derived schema mounted at the
 * `dist/index.js` boundary rejects any `filter` key it does not know about
 * (`additionalProperties: false`) — so every one of these five flags failed
 * with `invalid_argument ... additionalProperty: "<name>"` before `queryIssues`
 * ever ran, EVEN THOUGH `buildSearchArgv` (proven in-process by
 * `search-shortcut.spec.ts`) compiled a perfectly well-formed
 * `{"filter":{"plan":...}}` payload. An in-process test of `buildSearchArgv`
 * alone is structurally blind to this: the defect lives in the schema the
 * BUILT bin mounts, not in the pure argv-translation function.
 *
 * `repo`/`tag`/`family` had no persisted, filterable datum anywhere in this
 * package's write layer (see this repo's own defect report) and were REMOVED
 * from the flag surface rather than wired — `SEARCH_FLAGS`'s own "Available:"
 * list, asserted below, is the proof they no longer advertise a capability
 * that does not exist. `plan` and `project-path` DO resolve to a real,
 * persisted datum (a `part_of` edge to a plan issue; `component.meta.path`
 * respectively) and are now declared on `IIssueFilter` and wired in
 * `resolveEdgeScopedFilterIds` — this file proves both reach a real result
 * through the actual mounted schema, never a mock of the layer under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

const PROJECT_NAME = 'search-wire-project';

let tmpRoot: string;
let dbPath: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built bin — never imported, so the mount/schema layer this file exists to catch is actually exercised. */
function runBin(args: string[]): Run {
  const result = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      ADHD_BACKLOG_SCOPE: 'project',
      ADHD_BACKLOG_DATABASE_PATH: dbPath,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw new Error(`spawn failed: ${String(result.error)}`);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runJson(args: string[]): { run: Run; body: Record<string, unknown> } {
  const run = runBin(args);
  const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(
      `non-JSON stdout for ${args.join(' ')}: ${run.stdout}\n${run.stderr}`
    );
  }
  return { run, body };
}

/** Reads the `data` object off a success envelope, failing loudly on an error arm. */
function okData(args: string[]): Record<string, unknown> {
  const { run, body } = runJson(args);
  expect(
    run.status,
    `${args.join(' ')} exited ${String(run.status)}: ${run.stderr}`
  ).toBe(0);
  expect(
    body['ok'],
    `${args.join(' ')} returned an error arm: ${JSON.stringify(body)}`
  ).toBe(true);
  return body['data'] as Record<string, unknown>;
}

let planUid: string;
let memberUid: string;
let outsiderUid: string;
let targetComponentUid: string;
let inTargetUid: string;
let inSiblingUid: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-search-wire-'));
  dbPath = join(tmpRoot, 'search-wire.db');

  okData([
    'upsert-project',
    '--input',
    JSON.stringify({ name: PROJECT_NAME, by: 'search-wire.spec' }),
  ]);

  const target = okData([
    'upsert-component',
    '--input',
    JSON.stringify({
      project: PROJECT_NAME,
      name: 'wire-target',
      path: 'packages/wire/target',
      by: 'search-wire.spec',
    }),
  ]);
  targetComponentUid = target['uid'] as string;
  const sibling = okData([
    'upsert-component',
    '--input',
    JSON.stringify({
      project: PROJECT_NAME,
      name: 'wire-sibling',
      path: 'packages/wire/sibling',
      by: 'search-wire.spec',
    }),
  ]);

  planUid = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'search wire plan',
      body: 'plan body',
      project: PROJECT_NAME,
      kind: 'plan',
      by: 'search-wire.spec',
      duplicateAction: 'force',
    }),
  ])['uid'] as string;
  memberUid = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'search wire plan member',
      body: 'member body',
      project: PROJECT_NAME,
      by: 'search-wire.spec',
      duplicateAction: 'force',
    }),
  ])['uid'] as string;
  outsiderUid = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'search wire outsider',
      body: 'outsider body',
      project: PROJECT_NAME,
      by: 'search-wire.spec',
      duplicateAction: 'force',
    }),
  ])['uid'] as string;
  okData([
    'relate',
    '--input',
    JSON.stringify({
      sourceUid: memberUid,
      targetUid: planUid,
      rel: 'part_of',
      action: 'add',
      by: 'search-wire.spec',
    }),
  ]);

  inTargetUid = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'search wire in target',
      body: 'in target body',
      project: PROJECT_NAME,
      component: targetComponentUid,
      by: 'search-wire.spec',
      duplicateAction: 'force',
    }),
  ])['uid'] as string;
  inSiblingUid = okData([
    'create',
    '--input',
    JSON.stringify({
      title: 'search wire in sibling',
      body: 'in sibling body',
      project: PROJECT_NAME,
      component: sibling['uid'],
      by: 'search-wire.spec',
      duplicateAction: 'force',
    }),
  ])['uid'] as string;
}, 180_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('backlog search --plan / --project-path at the wire (real built bin)', () => {
  it('--repo, --tag, --family are no longer advertised — the surface stops offering a capability that does not exist', () => {
    for (const flag of ['--repo', '--tag', '--family']) {
      const run = runBin(['search', 'anything', flag, 'value']);
      expect(run.status, `${flag} unexpectedly succeeded`).not.toBe(0);
      const message = run.stderr.trim();
      expect(message).toContain(`Unknown option: ${flag}`);
      expect(message).not.toContain('additionalProperty');
    }
  });

  it('--plan reaches the real mounted schema (no additionalProperty rejection) and returns exactly the part_of member', () => {
    const run = runBin(['search', 'plan member', '--plan', planUid]);
    expect(
      run.status,
      `search --plan exited ${String(run.status)}: ${run.stderr}`
    ).toBe(0);
    const body = JSON.parse(
      run.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
    ) as Record<string, unknown>;
    expect(
      body['ok'],
      `search --plan returned an error arm: ${JSON.stringify(body)}`
    ).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    // The regression this suite exists for: `additionalProperty: "plan"` never
    // reaches a `data.items` key at all — asserting PRESENCE first is the
    // check with teeth (a schema rejection has no `items` key whatsoever).
    expect(Object.keys(data)).toContain('items');
    const uids = (data['items'] as Array<Record<string, unknown>>).map(
      (i) => i['uid']
    );
    expect(uids).toContain(memberUid);
    expect(uids).not.toContain(outsiderUid);
    expect(uids).not.toContain(planUid);
  });

  it("--project-path reaches the real mounted schema and returns exactly the matching component's issue", () => {
    const run = runBin([
      'search',
      'in target',
      '--project-path',
      'packages/wire/target',
    ]);
    expect(
      run.status,
      `search --project-path exited ${String(run.status)}: ${run.stderr}`
    ).toBe(0);
    const body = JSON.parse(
      run.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}'
    ) as Record<string, unknown>;
    expect(
      body['ok'],
      `search --project-path returned an error arm: ${JSON.stringify(body)}`
    ).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    expect(Object.keys(data)).toContain('items');
    const uids = (data['items'] as Array<Record<string, unknown>>).map(
      (i) => i['uid']
    );
    expect(uids).toContain(inTargetUid);
    expect(uids).not.toContain(inSiblingUid);
  });
});
