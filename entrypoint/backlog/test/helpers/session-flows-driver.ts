/**
 * session-flows-driver.ts — drives THREE real agent process flows through the
 * BUILT `adhd-backlog` bin against an isolated sandbox store, carrying
 * `sessionId`, and returns each flow's `timeline` output (B-AC8, 91a8c640).
 *
 * Used by `phase6-ab.e2e.ts` (asserts the flows) and by the one-shot generator
 * that wrote `docs/plan/backlog-consolidation/session-flows.md` from real output.
 * No import of the code under test: only the spawn helper, so it is the same
 * path a consumer takes (host wiring, dist resolution, envelope parsing).
 *
 * Flows:
 *  1. `S-flow-1` (agent-alpha): create -> claim -> transition -> release.
 *  2. `S-flow-2` (agent-beta) with child `S-flow-2.1` (agent-gamma): parent files
 *     and claims an epic; the child session files and moves a subtask.
 *  3. `S-flow-3` (agent-delta) with child `S-flow-3.1` (agent-epsilon): delta
 *     claims; epsilon force-reclaims the same item (the stale-reclaim path).
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintBacklogSandbox, runInBacklogSandbox, type SandboxHandle } from './spawn-backlog-bin.js';

export interface IEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}

export interface IFlowTimeline {
  name: string;
  sessionId: string;
  timeline: {
    session: { sessionId: string; agent: string; startedAt: string; endedAt?: string; parentSessionId?: string };
    children: string[];
    ops: Array<{ sessionId: string; agent: string; op: string; targetUid: string; delta: Record<string, unknown>; t: string }>;
    touched: string[];
  };
}

export interface ISessionFlowsResult {
  sandbox: SandboxHandle;
  flows: IFlowTimeline[];
  /** Active reservations seen mid-flow-3 (before the reclaim), by holder. */
  reservationsDuringFlow3: Array<{ path: string; uid: string; holder: string; sessionId: string | null }>;
  titles: Record<string, string>;
}

/** Run one verb on the sandboxed bin and parse the envelope (the last stdout line). */
export function call(sandbox: SandboxHandle, verb: string, input?: unknown): IEnvelope {
  const args = input === undefined ? [verb] : [verb, '--input', JSON.stringify(input)];
  const r = runInBacklogSandbox(sandbox, args);
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as IEnvelope;
  } catch {
    throw new Error(`${verb}: unparseable stdout (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
  }
}

export function ok(env: IEnvelope, what: string): Record<string, unknown> {
  if (!env.ok || env.data === undefined) throw new Error(`${what}: ${JSON.stringify(env)}`);
  return env.data;
}

export function driveSessionFlows(scratchDir: string): ISessionFlowsResult {
  const sandbox = mintBacklogSandbox();
  const root = join(realpathSync(scratchDir), 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  const fileA = join(root, 'src', 'alpha.ts');
  const fileB = join(root, 'src', 'beta.ts');
  const fileD = join(root, 'src', 'delta.ts');
  for (const f of [fileA, fileB, fileD]) writeFileSync(f, 'export {};\n');

  const project = ok(call(sandbox, 'upsert-project', { name: 'flows', path: root, by: 'seed' }), 'upsert-project')['uid'] as string;
  const titles: Record<string, string> = {};
  const create = (by: string, sessionId: string, title: string, file: string, parentSessionId?: string): string => {
    const uid = ok(
      call(sandbox, 'create', {
        project,
        title,
        body: `${title} — driven through the built bin`,
        by,
        sessionId,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        citations: [{ file }],
      }),
      `create ${title}`
    )['uid'] as string;
    titles[uid] = title;
    return uid;
  };
  const claim = (uid: string, by: string, sessionId: string, action: 'claim' | 'release' | 'renew', extra: Record<string, unknown> = {}) =>
    ok(call(sandbox, 'claim', { uid, by, action, sessionId, ...extra }), `claim ${action}`);
  const transition = (uid: string, by: string, sessionId: string, toStatus: string, note: string) =>
    ok(call(sandbox, 'transition', { uid, by, toStatus, note, sessionId }), `transition ${toStatus}`);

  // Flow 1
  const a = create('agent-alpha', 'S-flow-1', 'flow 1: fix the alpha module', fileA);
  claim(a, 'agent-alpha', 'S-flow-1', 'claim');
  transition(a, 'agent-alpha', 'S-flow-1', 'in_progress', 'started');
  claim(a, 'agent-alpha', 'S-flow-1', 'release');

  // Flow 2
  const epic = create('agent-beta', 'S-flow-2', 'flow 2: epic', fileB);
  claim(epic, 'agent-beta', 'S-flow-2', 'claim');
  const child = create('agent-gamma', 'S-flow-2.1', 'flow 2: child subtask', fileB, 'S-flow-2');
  transition(child, 'agent-gamma', 'S-flow-2.1', 'in_progress', 'child picks it up');

  // Flow 3
  const d = create('agent-delta', 'S-flow-3', 'flow 3: contested delta module', fileD);
  claim(d, 'agent-delta', 'S-flow-3', 'claim');
  const during = ok(call(sandbox, 'query', { view: 'reservations', filter: { pathPrefix: join(root, 'src') } }), 'reservations')['items'] as ISessionFlowsResult['reservationsDuringFlow3'];
  claim(d, 'agent-epsilon', 'S-flow-3.1', 'claim', { force: true, parentSessionId: 'S-flow-3' });

  const flows: IFlowTimeline[] = [
    ['flow 1: create, claim, transition, release', 'S-flow-1'],
    ['flow 2: parent epic with a child session', 'S-flow-2'],
    ['flow 3: contested claim and reclaim', 'S-flow-3'],
  ].map(([name, sessionId]) => ({
    name: name!,
    sessionId: sessionId!,
    timeline: ok(call(sandbox, 'timeline', { sessionId }), `timeline ${sessionId}`) as unknown as IFlowTimeline['timeline'],
  }));
  return { sandbox, flows, reservationsDuringFlow3: during, titles };
}
