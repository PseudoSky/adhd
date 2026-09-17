/**
 * registry-wire.spec.ts — SPEC.md §8 AC-9 ("Registry list") and AC-11
 * ("Registry detail") AT THE WIRE, driven through the REAL BUILT
 * `dist/index.js` as a child process — mirroring `paging-wire.spec.ts`'s
 * pattern exactly (see that file's own header for why an in-process
 * assertion cannot catch this defect class).
 *
 * ## Why this file exists at all, given `listProjects`/`listComponents`/
 * `listLocations`/`getRegistryDetail` are already fully tested in-process
 *
 * `views/registry.spec.ts` (real store, real scoping assertions) was green
 * for the ENTIRE period these functions were unreachable by every actual
 * consumer: `query`'s `view` union had no `projects`/`components`/`locations`
 * member, and `get`'s mounted input type had no `registry` field at all —
 * `src/api.ts` imported only `lookup` from `query/views/registry.js`. No
 * transport (CLI, MCP, HTTP) could reach any of the four functions. That is
 * the exact defect class `paging-wire.spec.ts` documents for `hasMore`/
 * `nextCursor`: the implementation was correct in-process the whole time; the
 * MOUNT was the gap. So the load-bearing assertions here are PRESENCE checks
 * (`Object.keys(data)).toContain(...)`), not just value comparisons — an
 * absent key is exactly the shape this defect class takes.
 *
 * ## The encoder trap this file also guards against
 *
 * `IIssueQueryResult`'s `view:'list'` member was once written as an inline
 * TypeScript intersection (`{view:'list'} & IIssuePage`), which apigen's
 * schema extractor cannot express — it silently emitted `{}` for that
 * branch and the runtime encoder projected the real value onto a SIBLING
 * union member, deleting `hasMore`/`nextCursor` from the wire
 * (`paging-wire.spec.ts`'s own header has the full account). The
 * `projects`/`components`/`locations` view members added here, and `get`'s
 * registry-detail result union, are written as plain named interfaces
 * (`IProjectSummary`/`IComponentDetail`/etc., declared with `extends`, never
 * an inline `&` intersection) for exactly that reason — this file's
 * assertions on the FULL expected field set (`path`, `repoUrl`,
 * `locations[]`, `components[]`, `project{...}`) are what would catch a
 * regression back into that trap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', '..', 'dist', 'index.js');

const PROJECT_A = 'registry-wire-project-a';
const PROJECT_B = 'registry-wire-project-b';

let tmpRoot: string;
let dbPath: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the REAL built bin. Never imported — an import resolves to source and skips the mount under test. */
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
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runJson(args: string[]): { run: Run; body: Record<string, unknown> } {
  const run = runBin(args);
  const line = run.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON stdout for ${args.join(' ')}: ${run.stdout}\n${run.stderr}`);
  }
  return { run, body };
}

/** Reads the `data` object off a success envelope, failing loudly on an error arm. */
function okData(args: string[]): Record<string, unknown> {
  const { run, body } = runJson(args);
  expect(run.status, `${args.join(' ')} exited ${String(run.status)}: ${run.stderr}`).toBe(0);
  expect(body['ok'], `${args.join(' ')} returned an error arm: ${JSON.stringify(body)}`).toBe(true);
  return body['data'] as Record<string, unknown>;
}

/** Reads the `error` object off a failure envelope, failing loudly on a success arm. */
function errData(args: string[]): Record<string, unknown> {
  const { run, body } = runJson(args);
  expect(body['ok'], `${args.join(' ')} unexpectedly succeeded: ${JSON.stringify(body)}`).toBe(false);
  return body['error'] as Record<string, unknown>;
}

let projectAUid: string;
let projectBUid: string;
let componentRootAUid: string;
let componentBackendUid: string;
let componentRootBUid: string;
let locationToolUid: string;
let locationPathUid: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'backlog-registry-wire-'));
  dbPath = join(tmpRoot, 'registry-wire.db');

  // Two projects, each carrying its own reserved `(root)` component — the
  // exact name-collision AC-23 names ("every project's reserved `(root)`
  // component shares the same name") and what AC-11's `filter.project`
  // scoping on `get{registry:'component',...}` exists to disambiguate.
  const projectA = okData([
    'upsert-project',
    '--input',
    JSON.stringify({ name: PROJECT_A, path: '/repo/registry-wire-a', repoUrl: 'git@github.com:acme/registry-wire-a.git', by: 'registry-wire.spec' }),
  ]);
  projectAUid = projectA['uid'] as string;

  const projectB = okData([
    'upsert-project',
    '--input',
    JSON.stringify({ name: PROJECT_B, path: '/repo/registry-wire-b', repoUrl: 'git@github.com:acme/registry-wire-b.git', by: 'registry-wire.spec' }),
  ]);
  projectBUid = projectB['uid'] as string;

  // `upsertProject` mints the reserved `(root)` component atomically
  // (SPEC.md §3/§3a) — resolve its uid via `query view:'components'` itself
  // (the same mount AC-9 proves below), rather than re-deriving it.
  const projectAComponents = okData(['query', '--input', JSON.stringify({ view: 'components', filter: { project: PROJECT_A } })])['items'] as Array<{ uid: string; name: string }>;
  componentRootAUid = projectAComponents.find((c) => c.name === '(root)')!.uid;

  const projectBComponents = okData(['query', '--input', JSON.stringify({ view: 'components', filter: { project: PROJECT_B } })])['items'] as Array<{ uid: string; name: string }>;
  componentRootBUid = projectBComponents.find((c) => c.name === '(root)')!.uid;

  const backend = okData([
    'upsert-component',
    '--input',
    JSON.stringify({ project: PROJECT_A, name: 'registry-wire-backend', path: 'packages/registry-wire-backend', description: 'the backend component', by: 'registry-wire.spec' }),
  ]);
  componentBackendUid = backend['uid'] as string;

  const locTool = okData([
    'upsert-location',
    '--input',
    JSON.stringify({ component: componentBackendUid, locType: 'tool', value: 'registry_wire_tool', by: 'registry-wire.spec' }),
  ]);
  locationToolUid = locTool['uid'] as string;

  const locPath = okData([
    'upsert-location',
    '--input',
    JSON.stringify({ component: componentBackendUid, locType: 'path', value: '/repo/registry-wire-a/packages/registry-wire-backend/src/index.ts', by: 'registry-wire.spec' }),
  ]);
  locationPathUid = locPath['uid'] as string;
}, 180_000);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AC-9 — registry LIST views at the wire (real built bin)', () => {
  it('view:"projects" returns the seeded projects, full field set survives encoding', () => {
    const data = okData(['query', '--input', JSON.stringify({ view: 'projects' })]);

    expect(Object.keys(data)).toContain('view');
    expect(data['view']).toBe('projects');
    expect(Object.keys(data)).toContain('items');
    const items = data['items'] as Array<Record<string, unknown>>;
    const names = items.map((p) => p['name']);
    expect(names).toContain(PROJECT_A);
    expect(names).toContain(PROJECT_B);

    const a = items.find((p) => p['name'] === PROJECT_A)!;
    // Presence checks first — an absent key is exactly the defect class this
    // file exists to catch (paging-wire.spec.ts's own doc comment).
    expect(Object.keys(a)).toContain('uid');
    expect(Object.keys(a)).toContain('path');
    expect(Object.keys(a)).toContain('repoUrl');
    expect(a['uid']).toBe(projectAUid);
    expect(a['path']).toBe('/repo/registry-wire-a');
    expect(a['repoUrl']).toBe('git@github.com:acme/registry-wire-a.git');
  });

  it('view:"components" UNFILTERED returns components from BOTH seeded projects', () => {
    const data = okData(['query', '--input', JSON.stringify({ view: 'components' })]);
    const items = data['items'] as Array<Record<string, unknown>>;
    const names = items.map((c) => c['name']);
    expect(names).toContain('registry-wire-backend');
    // Every project's reserved `(root)` component is present, unfiltered.
    expect(items.filter((c) => c['name'] === '(root)').length).toBeGreaterThanOrEqual(2);
  });

  it('view:"components" scoped by filter.project returns ONLY that project\'s components', () => {
    const data = okData(['query', '--input', JSON.stringify({ view: 'components', filter: { project: PROJECT_A } })]);
    const items = data['items'] as Array<Record<string, unknown>>;
    const names = items.map((c) => c['name']).sort();
    expect(names).toEqual(['(root)', 'registry-wire-backend']);
    for (const c of items) {
      expect(Object.keys(c)).toContain('projectUid');
      expect(c['projectUid']).toBe(projectAUid);
    }

    // The sibling project's components must NOT leak in.
    const scopedB = okData(['query', '--input', JSON.stringify({ view: 'components', filter: { project: PROJECT_B } })])['items'] as Array<Record<string, unknown>>;
    expect(scopedB.map((c) => c['name'])).toEqual(['(root)']);
    expect(scopedB.some((c) => c['uid'] === componentBackendUid)).toBe(false);
  });

  it('view:"locations" returns the seeded tool + path locations, scoped by filter.component', () => {
    const unfiltered = okData(['query', '--input', JSON.stringify({ view: 'locations' })])['items'] as Array<Record<string, unknown>>;
    const uids = unfiltered.map((l) => l['uid']);
    expect(uids).toContain(locationToolUid);
    expect(uids).toContain(locationPathUid);

    const scoped = okData(['query', '--input', JSON.stringify({ view: 'locations', filter: { component: componentBackendUid } })])['items'] as Array<Record<string, unknown>>;
    expect(scoped).toHaveLength(2);
    for (const l of scoped) {
      expect(Object.keys(l)).toContain('locType');
      expect(Object.keys(l)).toContain('value');
      expect(Object.keys(l)).toContain('componentUid');
      expect(l['componentUid']).toBe(componentBackendUid);
    }
  });
});

describe('AC-11 — registry DETAIL via `get` at the wire (real built bin)', () => {
  it('get{registry:"project",...} returns path, repoUrl, and its linked locations[]+components[] — full field set survives encoding', () => {
    const data = okData(['get', '--input', JSON.stringify({ registry: 'project', name: PROJECT_A })]);

    // Presence first (the absent-key defect class), then value.
    for (const key of ['uid', 'name', 'path', 'repoUrl', 'components', 'locations']) {
      expect(Object.keys(data), `missing key "${key}": ${JSON.stringify(data)}`).toContain(key);
    }
    expect(data['name']).toBe(PROJECT_A);
    expect(data['path']).toBe('/repo/registry-wire-a');
    expect(data['repoUrl']).toBe('git@github.com:acme/registry-wire-a.git');

    const components = data['components'] as Array<{ name: string }>;
    expect(components.map((c) => c.name).sort()).toEqual(['(root)', 'registry-wire-backend']);

    const locations = data['locations'] as Array<{ locType: string; value: string }>;
    expect(locations.map((l) => l.value).sort()).toEqual([
      '/repo/registry-wire-a/packages/registry-wire-backend/src/index.ts',
      'registry_wire_tool',
    ]);
  });

  it('get{registry:"component",...} returns its owning project object and locations[]', () => {
    const data = okData(['get', '--input', JSON.stringify({ registry: 'component', name: 'registry-wire-backend' })]);

    for (const key of ['uid', 'name', 'projectUid', 'project', 'locations']) {
      expect(Object.keys(data), `missing key "${key}": ${JSON.stringify(data)}`).toContain(key);
    }
    expect(data['name']).toBe('registry-wire-backend');
    expect(data['projectUid']).toBe(projectAUid);

    const project = data['project'] as Record<string, unknown>;
    expect(Object.keys(project)).toContain('name');
    expect(Object.keys(project)).toContain('path');
    expect(Object.keys(project)).toContain('repoUrl');
    expect(project['name']).toBe(PROJECT_A);

    expect((data['locations'] as unknown[]).length).toBe(2);
  });

  it('get{registry:"component", name:"(root)", filter:{project:...}} resolves to the SAME project\'s (root) — not the other project\'s namesake (AC-23 collision, AC-11 scoping)', () => {
    const dataA = okData(['get', '--input', JSON.stringify({ registry: 'component', name: '(root)', filter: { project: PROJECT_A } })]);
    expect(dataA['uid']).toBe(componentRootAUid);
    expect((dataA['project'] as Record<string, unknown>)['name']).toBe(PROJECT_A);

    const dataB = okData(['get', '--input', JSON.stringify({ registry: 'component', name: '(root)', filter: { project: PROJECT_B } })]);
    expect(dataB['uid']).toBe(componentRootBUid);
    expect((dataB['project'] as Record<string, unknown>)['name']).toBe(PROJECT_B);

    // The two `(root)` rows are genuinely distinct nodes sharing a name.
    expect(dataA['uid']).not.toBe(dataB['uid']);
  });

  it('get{registry:"location",...} resolves by uid, returning its component AND project', () => {
    const data = okData(['get', '--input', JSON.stringify({ registry: 'location', name: locationToolUid })]);

    for (const key of ['uid', 'locType', 'value', 'componentUid', 'component', 'project']) {
      expect(Object.keys(data), `missing key "${key}": ${JSON.stringify(data)}`).toContain(key);
    }
    expect(data['value']).toBe('registry_wire_tool');
    expect((data['component'] as Record<string, unknown>)['name']).toBe('registry-wire-backend');
    expect((data['project'] as Record<string, unknown>)['name']).toBe(PROJECT_A);
  });

  it('get{registry:"project",...} for an unresolved name throws a wire-visible not_found error, never a phantom detail', () => {
    const error = errData(['get', '--input', JSON.stringify({ registry: 'project', name: 'registry-wire-does-not-exist' })]);
    expect(error['code']).toBe('not_found');
  });

  it('AC-13 unchanged: get{uid} still returns EXACTLY the five-field default card, not a registry shape', () => {
    const created = okData([
      'create',
      '--input',
      JSON.stringify({
        title: 'registry-wire get(uid) control',
        body: 'proves the uid-addressed get path is untouched by the registry addition',
        project: PROJECT_A,
        // `priority` is genuinely optional on `createIssue` — an omitted
        // priority mints no `has_priority` edge, so the card would never
        // populate the `priority` key regardless of the default-fields set
        // (SPEC.md §8 AC-13 claims the DEFAULT FIELD SET includes `priority`,
        // not merely that an unset priority happens to also be absent —
        // `get.spec.ts`'s own in-process test makes the identical call).
        priority: 'p1',
        by: 'registry-wire.spec',
        duplicateAction: 'force',
      }),
    ]);
    const uid = created['uid'] as string;

    const data = okData(['get', '--input', JSON.stringify({ uid })]);
    expect(Object.keys(data).sort()).toEqual(['kind', 'priority', 'status', 'title', 'uid'].sort());
  });

  it('a worktree directory under the project resolves to the SAME project row — never a phantom row', () => {
    // `upsertProject` is the write path a caller operating from a worktree
    // checkout of the SAME repo would hit again (SPEC.md §3: "A worktree
    // directory under the project resolves to the SAME project row — never
    // a phantom row"); its uniqueness key is `name` alone (§8 AC-12), so a
    // second call naming a DIFFERENT absolute `path` (a worktree root, e.g.
    // `.worktrees/<id>` under the same checkout) must still resolve to the
    // SAME row — not mint a second one.
    const worktreePath = '/repo/registry-wire-a/.worktrees/registry-wire-ac11';
    const second = okData([
      'upsert-project',
      '--input',
      JSON.stringify({ name: PROJECT_A, path: worktreePath, repoUrl: 'git@github.com:acme/registry-wire-a.git', by: 'registry-wire.spec' }),
    ]);
    expect(second['uid']).toBe(projectAUid);

    // `get{registry:'project',...}` still resolves the ONE row — no phantom
    // second project appeared under any name.
    const detail = okData(['get', '--input', JSON.stringify({ registry: 'project', name: PROJECT_A })]);
    expect(detail['uid']).toBe(projectAUid);

    const projects = okData(['query', '--input', JSON.stringify({ view: 'projects' })])['items'] as Array<Record<string, unknown>>;
    expect(projects.filter((p) => p['name'] === PROJECT_A)).toHaveLength(1);
  });
});
