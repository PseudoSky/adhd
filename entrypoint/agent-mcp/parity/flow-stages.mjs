// PARITY-INSTRUMENT-ONLY
// R11 AC11 / AC12: the flow-stage detector and the failure naming of the "backlog-operator" design. Private, unpublished measurement instrument (see README.md "R11: the backlog-operator design").
//
// The owner's stop condition (SCOPE-R11-stop-condition): a group is done when it built a ticket end to end: backlog-operator dispatched and an item selected, the item implemented with a commit,
// a review dispatched on that code, the code revised and committed after the review, and the same backlog operator transitioning the item afterwards. The detector reads those five stages from
// STATE, never from the agent's own report:
//   S1 the backlog operator was dispatched through agent-mcp and an unblocked item was selected      (task records + the operator's backlog tool calls + the before read-back)
//   S2 an implementation commit that touches files exists in the group worktree                       (git log)
//   S3 a `review` agent was dispatched through agent-mcp after the implementation and finished        (task records, ordered against S2)
//   S4 a revision commit that touches files exists after the review                                   (git log, ordered against the review task window)
//   S5 a backlog operator task created after the revision transitioned the item and the item's status changed in the after read-back   (task records + the before/after backlog read-back)
// Every stage is `pass` | `fail` | `unknown`. Absent data is `unknown`, never `pass`: a missing input leaves its stage (and any stage that depends on it) unknown. `flowComplete` is true only when all five
// stages are `pass`. Ordering rule: tasks carry millisecond timestamps, commits carry second-resolution committer times, so a commit-versus-task comparison is made on whole seconds; a
// commit made in the same second as a task boundary counts as on the allowed side of it (commit <= review start for the implementation, commit >= review end for the revision), and two commits
// are only accepted as implementation + revision when they are DISTINCT commits in git order. A tie can therefore only resolve toward the true order (the work happens in that order); it cannot
// invent a commit that is not in the log.
//
// Pure functions over plain data: this module imports nothing, so it is unit-testable with synthetic fixtures (r11-flow.test.ts) and shared by the runner, analyze and the self-check.

export const STAGE_IDS = Object.freeze(['S1', 'S2', 'S3', 'S4', 'S5']);
export const STAGE_NAMES = Object.freeze({
  S1: 'backlog-operator dispatched and an unblocked item selected',
  S2: 'implementation commit touching files in the group worktree',
  S3: 'review agent dispatched after the implementation',
  S4: 'revision commit touching files after the review',
  S5: 'backlog-operator (again, after the revision) transitioned the item; status changed in the read-back',
});
export const AGENT_NAMES = Object.freeze({ parent: 'performance', operator: 'backlog-operator', reviewer: 'review' });

/** Text in a tool result that means the call was refused or failed (sandbox, hook, permission, non-zero exit), as opposed to a result that merely contains the word error in prose. */
export const ERROR_LIKE = /Operation not permitted|Permission denied|EACCES|\bfatal:|\[exit status: [1-9]\d*\]|hook (?:declined|failed)|pre-commit hook/i;
/** A short window of the failing text around the first match, so the record names the refusal itself. */
export function errorSnippet(text, width = 260) { const t = String(text).replace(/\s+/g, ' '); const m = ERROR_LIKE.exec(t); const at = m ? Math.max(0, m.index - 120) : 0; return t.slice(at, at + width); }

const sec = (ms) => Math.floor(ms / 1000);
const msOf = (iso) => { const n = Date.parse(iso); return Number.isFinite(n) ? n : null; };
const id8 = (id) => String(id ?? '?').slice(0, 8);
const stage = (status, detail, evidence = []) => ({ status, detail, evidence });
const isTransition = (c) => /(^|__)backlog_transition$/.test(String(c?.name));
const uidOf = (input) => { const o = input ?? {}; return o?.data?.input?.uid ?? o?.input?.uid ?? o?.uid ?? null; };
const touches = (c) => Array.isArray(c?.files) && c.files.length > 0;
const taskRef = (t) => `task ${t.agent ?? '?'} ${id8(t.taskId)}${t.parentTaskId ? ` (parent ${id8(t.parentTaskId)})` : ''}`;
const commitRef = (c) => `commit ${String(c.sha).slice(0, 10)} "${String(c.subject ?? '').slice(0, 60)}" files [${(c.files ?? []).slice(0, 4).join(', ')}${(c.files ?? []).length > 4 ? ', ...' : ''}] at ${c.ts == null ? '?' : new Date(c.ts * 1000).toISOString()}`;

/**
 * Derive the five stages of one group.
 * @param {object} a
 * @param {null|Array<{taskId:string, agent:string|null, sessionId?:string|null, parentTaskId:string|null, status:string, createdAt:string|null, completedAt:string|null, calls?:Array<{name:string, input?:any, isError?:boolean|null, resultText?:string|null}>}>} a.tasks  every agent-mcp task of the run (null: not available)
 * @param {null|Array<{sha:string, subject?:string, ts:number|null, files:string[]}>} a.commits  commits made in the group worktree after the base, OLDEST FIRST (ts = committer time, epoch seconds) (null: not available)
 * @param {null|{picked:string|null, wasInReadyViewBefore?:boolean, readySnapshotComplete?:boolean, statusBefore?:string|null, statusAfter?:string|null, transitioned?:boolean|string, afterError?:string|null}} a.item  the before/after read-back of the picked item (null: not available)
 * @param {{parent?:string, operator?:string, reviewer?:string}} [a.agents]
 * @returns {{stages:Record<string,{status:'pass'|'fail'|'unknown', detail:string, evidence:string[]}>, flowComplete:boolean, firstNotPassed:string|null, line:string}}
 */
export function detectFlow({ tasks, commits, item, agents = AGENT_NAMES }) {
  const A = { ...AGENT_NAMES, ...agents };
  const stages = {};
  const T = Array.isArray(tasks) ? tasks : null;
  const C = Array.isArray(commits) ? commits : null;
  const opTasks = T ? T.filter((t) => t.agent === A.operator && t.parentTaskId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
  const firstOp = opTasks?.[0] ?? null;
  const reviewTasks = T ? T.filter((t) => t.agent === A.reviewer && t.parentTaskId && (!firstOp || (msOf(t.createdAt) ?? 0) >= (msOf(firstOp.createdAt) ?? 0))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
  const review = reviewTasks?.[0] ?? null;

  // S1 ----------------------------------------------------------------------------------------------------------------
  if (!T) stages.S1 = stage('unknown', 'no agent-mcp task records were captured');
  else if (!firstOp) stages.S1 = stage('fail', `no ${A.operator} task was dispatched through agent-mcp (no child task of agent ${A.operator})`, T.map(taskRef));
  else if (!item) stages.S1 = stage('unknown', `${A.operator} was dispatched but the backlog read-back is not available`, [taskRef(firstOp)]);
  else if (!item.picked) stages.S1 = stage('fail', `${A.operator} was dispatched (${taskRef(firstOp)}) but no item was selected (no successful backlog_claim / backlog_transition call)`, [taskRef(firstOp)]);
  else if (item.wasInReadyViewBefore === false) stages.S1 = item.readySnapshotComplete === false
    ? stage('unknown', `item ${item.picked} was not in the ready snapshot, which is incomplete: unblocked-ness cannot be confirmed`, [taskRef(firstOp), `item ${item.picked}`])
    : stage('fail', `item ${item.picked} was selected but is not in the pre-run ready (unblocked) view`, [taskRef(firstOp), `item ${item.picked}`]);
  else if (item.wasInReadyViewBefore !== true) stages.S1 = stage('unknown', `item ${item.picked} selected; whether it was in the ready view is not recorded`, [taskRef(firstOp)]);
  else stages.S1 = stage('pass', `${A.operator} dispatched through agent-mcp; item ${item.picked} (was ${item.statusBefore ?? '?'}, in the ready view)`, [taskRef(firstOp), `item ${item.picked} in the pre-run ready view`]);

  // S2 ----------------------------------------------------------------------------------------------------------------
  const rStart = review ? msOf(review.createdAt) : null;
  let impl = null;
  if (!C) stages.S2 = stage('unknown', 'no git log of the group worktree was captured');
  else {
    const withFiles = C.filter(touches);
    if (!withFiles.length) stages.S2 = stage('fail', C.length ? `${C.length} commit(s) exist but none touches a file` : 'no commit was made in the group worktree', C.map(commitRef));
    else if (!review) { impl = withFiles[0]; stages.S2 = stage('pass', `implementation commit ${String(impl.sha).slice(0, 10)} touching ${impl.files.length} file(s)`, [commitRef(impl)]); }
    else if (rStart == null) stages.S2 = stage('unknown', 'the review task has no creation time: the commit cannot be ordered before it', [taskRef(review)]);
    else {
      impl = withFiles.find((c) => c.ts != null && c.ts <= sec(rStart)) ?? null;
      if (impl) stages.S2 = stage('pass', `implementation commit ${String(impl.sha).slice(0, 10)} touching ${impl.files.length} file(s), at or before the review dispatch`, [commitRef(impl)]);
      else if (withFiles.some((c) => c.ts == null)) stages.S2 = stage('unknown', 'a commit has no committer time', withFiles.map(commitRef));
      else stages.S2 = stage('fail', 'every commit touching files is later than the review dispatch: no implementation commit precedes the review', [...withFiles.map(commitRef), taskRef(review)]);
    }
  }

  // S3 ----------------------------------------------------------------------------------------------------------------
  if (!T) stages.S3 = stage('unknown', 'no agent-mcp task records were captured');
  else if (!review) stages.S3 = stage('fail', `no ${A.reviewer} task was dispatched through agent-mcp after ${A.operator} (child tasks: ${T.filter((t) => t.parentTaskId).map((t) => t.agent ?? '?').join(', ') || 'none'})`, T.map(taskRef));
  else if (review.status !== 'completed') stages.S3 = stage('fail', `${taskRef(review)} ended ${review.status}${review.error ? ` (${String(review.error).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`, [taskRef(review)]);
  else if (stages.S2.status === 'unknown') stages.S3 = stage('unknown', 'the review ran but the implementation commit cannot be ordered before it (no git log)', [taskRef(review)]);
  else if (stages.S2.status === 'fail') stages.S3 = stage('fail', 'a review was dispatched but no implementation commit precedes it: the review had no committed code to review', [taskRef(review), stages.S2.detail]);
  else stages.S3 = stage('pass', `${taskRef(review)} completed after the implementation commit ${String(impl?.sha ?? '').slice(0, 10)}${reviewTasks.length > 1 ? ` (${reviewTasks.length} review tasks; the first is used)` : ''}`, [taskRef(review), ...(impl ? [commitRef(impl)] : [])]);

  // S4 ----------------------------------------------------------------------------------------------------------------
  const rEnd = review ? msOf(review.completedAt) : null;
  let revision = null;
  if (!C) stages.S4 = stage('unknown', 'no git log of the group worktree was captured');
  else if (!review) stages.S4 = stage(T ? 'fail' : 'unknown', T ? 'no review was dispatched, so no commit can follow one' : 'no task records: the review window is unknown', []);
  else if (review.status !== 'completed') stages.S4 = stage('fail', `the review did not complete (${review.status}): no revision can be based on it`, [taskRef(review)]);
  else if (rEnd == null) stages.S4 = stage('unknown', 'the review task has no completion time: a later commit cannot be proven', [taskRef(review)]);
  else {
    const implIdx = impl ? C.indexOf(impl) : -1;
    const later = C.filter((c, i) => touches(c) && c !== impl && (implIdx < 0 || i > implIdx));
    revision = later.find((c) => c.ts != null && c.ts >= sec(rEnd)) ?? null;
    if (revision) stages.S4 = stage('pass', `revision commit ${String(revision.sha).slice(0, 10)} touching ${revision.files.length} file(s) after the review completed`, [commitRef(revision), taskRef(review)]);
    else if (later.some((c) => c.ts == null)) stages.S4 = stage('unknown', 'a later commit has no committer time', later.map(commitRef));
    else stages.S4 = stage('fail', later.length ? 'commits exist after the implementation but all predate the review completion: nothing was revised in response to it' : 'no commit after the implementation commit: the code was not revised after the review', [...later.map(commitRef), taskRef(review)]);
  }

  // S5 ----------------------------------------------------------------------------------------------------------------
  if (!T) stages.S5 = stage('unknown', 'no agent-mcp task records were captured');
  else if (!firstOp) stages.S5 = stage('fail', `${A.operator} never ran`, []);
  else {
    const picked = item?.picked ?? null;
    const afterRev = (opTasks ?? []).filter((t) => {
      const created = msOf(t.createdAt); if (created == null) return false;
      if (rEnd != null && created < rEnd) return false;                                    // must start after the review finished (task vs task, millisecond precision)
      if (revision?.ts != null && sec(created) < revision.ts) return false;                // and after the revision commit
      return true;
    });
    const transitions = afterRev.flatMap((t) => (t.calls ?? []).filter((c) => isTransition(c) && c.isError !== true && (!picked || uidOf(c.input) === picked)).map((c) => ({ t, c })));
    const sameSession = firstOp.sessionId != null && afterRev.some((t) => t.sessionId === firstOp.sessionId);
    const allTransitionTasks = (opTasks ?? []).filter((t) => (t.calls ?? []).some((c) => isTransition(c) && c.isError !== true));
    if (stages.S4.status === 'fail') stages.S5 = stage('fail', `the item cannot have been transitioned after a revision: S4 did not pass (${stages.S4.detail})${allTransitionTasks.length ? `; a transition exists in ${A.operator} task(s) ${allTransitionTasks.map((t) => id8(t.taskId)).join(', ')}` : ''}`, allTransitionTasks.map(taskRef));
    else if (!transitions.length) stages.S5 = stage('fail', `${A.operator} made no successful backlog_transition in a task started after the ${revision ? 'revision commit' : 'review'}${allTransitionTasks.length ? ` (a transition exists only in earlier task(s): ${allTransitionTasks.map((t) => id8(t.taskId)).join(', ')})` : ''}`, (opTasks ?? []).map(taskRef));
    else if (!item) stages.S5 = stage('unknown', 'a transition call was made after the revision but the after read-back is not available', transitions.map((x) => taskRef(x.t)));
    else if (item.afterError) stages.S5 = stage('unknown', `the after read-back failed: ${String(item.afterError).slice(0, 120)}`, transitions.map((x) => taskRef(x.t)));
    else if (typeof item.transitioned === 'string') stages.S5 = stage('unknown', String(item.transitioned), transitions.map((x) => taskRef(x.t)));
    else if (stages.S4.status === 'unknown') stages.S5 = stage('unknown', 'the transition happened after the review but the revision commit could not be established (S4 unknown)', transitions.map((x) => taskRef(x.t)));
    else if (item.transitioned !== true) stages.S5 = stage('fail', `a transition call was made but the item's status did not change in the read-back (${item.statusBefore ?? '?'} -> ${item.statusAfter ?? '?'})`, transitions.map((x) => taskRef(x.t)));
    else stages.S5 = stage('pass', `${taskRef(transitions.at(-1).t)} transitioned ${picked} after the revision (${item.statusBefore ?? '?'} -> ${item.statusAfter ?? '?'})${sameSession ? '; same operator session as the selecting task' : '; a different operator session than the selecting task'}`, [...transitions.map((x) => taskRef(x.t)), `item ${picked}: ${item.statusBefore ?? '?'} -> ${item.statusAfter ?? '?'} (read-back)`]);
  }

  const flowComplete = STAGE_IDS.every((s) => stages[s].status === 'pass');
  const firstNotPassed = STAGE_IDS.find((s) => stages[s].status !== 'pass') ?? null;
  return { stages, flowComplete, firstNotPassed, line: flowLine({ stages, flowComplete }) };
}

/** `S1 pass S2 pass S3 fail S4 unknown S5 unknown | flow incomplete` */
export function flowLine(flow) {
  return `${STAGE_IDS.map((s) => `${s} ${flow.stages?.[s]?.status ?? 'unknown'}`).join(' ')} | flow ${flow.flowComplete ? 'COMPLETE' : 'incomplete'}`;
}

/**
 * R11 AC12: for every stage that did not pass, name the failing step: the task, its agent, its last tool call and the error text, taken from the trace (not from the agent's report).
 * @returns {Array<{stage:string, status:string, step:string, detail:string, task:null|{taskId:string, agent:string|null, status:string, error:string|null}, lastToolCall:null|{name:string, isError:boolean|null}, errorText:string|null}>}
 */
export function explainStages({ flow, tasks, agents = AGENT_NAMES }) {
  const A = { ...AGENT_NAMES, ...agents };
  const T = Array.isArray(tasks) ? tasks : [];
  const byAgent = (name) => T.filter((t) => t.agent === name).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const focus = { S1: byAgent(A.operator).at(0) ?? byAgent(A.parent).at(0), S2: byAgent(A.operator).at(0), S3: byAgent(A.reviewer).at(0) ?? byAgent(A.parent).at(0), S4: byAgent(A.parent).at(0), S5: byAgent(A.operator).at(-1) ?? byAgent(A.parent).at(0) };
  const out = [];
  for (const s of STAGE_IDS) {
    const st = flow.stages[s]; if (st.status === 'pass') continue;
    const t = focus[s] ?? null; const calls = t?.calls ?? [];
    const last = calls.at(-1) ?? null;
    const bad = [...calls].reverse().find((c) => c.isError === true || (c.resultText != null && ERROR_LIKE.test(String(c.resultText)))) ?? null;
    out.push({ stage: s, status: st.status, step: `${s} ${STAGE_NAMES[s]}`, detail: st.detail,
      task: t ? { taskId: t.taskId, agent: t.agent ?? null, status: t.status, error: t.error ?? null } : null,
      lastToolCall: last ? { name: last.name, isError: last.isError ?? null } : null,
      errorText: bad ? errorSnippet(bad.resultText ?? '') : (t?.error ? String(t.error).replace(/\s+/g, ' ').slice(0, 260) : null) });
  }
  return out;
}

/**
 * R11 AC12: repeated tool errors in one task are a bug candidate (owner rule: repeated tool errors are bugs). A call counts as an error when the engine marked it isError or its result text matches
 * ERROR_LIKE. Grouped per (task, tool name); `threshold` or more is reported.
 * @returns {Array<{taskId:string, agent:string|null, tool:string, count:number, sample:string, bugCandidate:true}>}
 */
export function repeatedToolErrors(tasks, { threshold = 2 } = {}) {
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const by = new Map();
    for (const c of t.calls ?? []) {
      const failed = c.isError === true || (c.resultText != null && ERROR_LIKE.test(String(c.resultText)));
      if (!failed) continue;
      const e = by.get(c.name) ?? { count: 0, sample: errorSnippet(c.resultText ?? '(no result text recorded)') }; e.count++; by.set(c.name, e);
    }
    for (const [tool, e] of by) if (e.count >= threshold) out.push({ taskId: t.taskId, agent: t.agent ?? null, tool, count: e.count, sample: e.sample, bugCandidate: true });
  }
  return out;
}
