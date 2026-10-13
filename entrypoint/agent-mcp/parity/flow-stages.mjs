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

// ----------------------------------------------------------------------------------------------------------------
// R12 (SCOPE-R12-backlog-cli): the backlog-operator reaches the backlog through the `adhd-backlog` CLI in its shell tool, not through an MCP server. A backlog call is then a
// `shell_execute {command:[argv...], directory}` call whose argv[0] is the CLI (compared by basename: the model may spell an absolute path). The helpers below read those calls from the task
// record; they are pure and shared by detectFlow (access 'cli'), the picked-item derivation and the failure naming.
// ----------------------------------------------------------------------------------------------------------------
export const BACKLOG_CLI = 'adhd-backlog';
/** Verbs that change the store (the CLI refuses them on the production store without `--allow-production-write`). */
export const CLI_WRITE_VERBS = Object.freeze(['claim', 'transition', 'create', 'update', 'relate', 'delete', 'remove', 'restore', 'move', 'obligate', 'unobligate', 'attest', 'recheck', 'add-citation', 'remove-citation', 'merge-project', 'rm-project', 'rm-location', 'spec-append', 'upsert-component', 'upsert-location', 'upsert-project']);
const baseOf = (p) => String(p ?? '').split('/').pop();
const isShellCall = (c) => /(^|__)shell_execute$/.test(String(c?.name));
const HEX_PREFIX = /^[0-9a-f]{8,}(?:-[0-9a-f-]*)?$/i;
/**
 * Parse one tool call as an `adhd-backlog` invocation, or null when it is not one. The uid is taken ONLY from the call's own input (the `--input` JSON, or the positional of `get <uid>`):
 * a `query` lists many uids in its RESULT and selects none. `--allow-production-write` and `--namespace <v>` are global switches and are not part of the verb.
 * @returns {null|{verb:string|null, uid:string|null, toStatus:string|null, input:object|null, allowProductionWrite:boolean, namespace:string|null, isWrite:boolean, argv:string[]}}
 */
export function parseCliCall(call) {
  if (!isShellCall(call)) return null;
  let argv = call?.input?.command;
  if (typeof argv === 'string') argv = argv.trim().split(/\s+/);
  if (!Array.isArray(argv) || !argv.length || baseOf(argv[0]) !== BACKLOG_CLI) return null;
  const rest = argv.slice(1).map(String); const toks = []; let allowProductionWrite = false; let namespace = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--allow-production-write') { allowProductionWrite = true; continue; }
    if (rest[i] === '--namespace') { namespace = rest[++i] ?? null; continue; }
    if (rest[i].startsWith('--namespace=')) { namespace = rest[i].slice('--namespace='.length); continue; }
    toks.push(rest[i]);
  }
  let verb = null; let input = null; const positionals = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--input') { try { input = JSON.parse(toks[++i] ?? ''); } catch { input = null; } continue; }
    if (t.startsWith('--input=')) { try { input = JSON.parse(t.slice('--input='.length)); } catch { input = null; } continue; }
    if (t.startsWith('--')) { i++; continue; }   // another value-taking flag (--limit 5): skipped with its value
    if (verb == null) verb = t; else positionals.push(t);
  }
  const env = input?.data?.input ?? input?.input ?? input ?? {};
  const uid = (typeof env?.uid === 'string' && env.uid) || (verb === 'get' && positionals[0] && HEX_PREFIX.test(positionals[0]) ? positionals[0] : null) || null;
  return { verb, uid, toStatus: typeof env?.toStatus === 'string' ? env.toStatus : null, input: input && typeof input === 'object' ? input : null, allowProductionWrite, namespace, isWrite: CLI_WRITE_VERBS.includes(verb), argv };
}
/**
 * Did this CLI call succeed? Never from the exit code alone and never from log noise: the call must not be marked an error by the engine, its output must carry the CLI's own success
 * envelope line (`{"ok":true`; the structured log lines the CLI prints around it are ignored) and no non-zero `[exit status: N]` sentinel.
 * @returns {{ok:boolean, why:string|null}}
 */
export function cliOutcome(call) {
  const text = String(call?.resultText ?? '');
  if (call?.isError === true) return { ok: false, why: 'the engine marked the call an error' };
  if (/\[exit status: [1-9]\d*\]/.test(text)) return { ok: false, why: 'non-zero exit status' };
  if (/^\s*\{"ok":false\b/m.test(text)) return { ok: false, why: 'the CLI answered {"ok":false}' };
  if (!/^\s*\{"ok":true\b/m.test(text)) return { ok: false, why: call?.resultText == null ? 'no result recorded' : 'no {"ok":true} envelope in the output' };
  return { ok: true, why: null };
}
/** `a` names the same item as `full` (equal, or `a` is a unique-prefix form of 8+ hex characters, which the CLI accepts). */
export const sameUid = (a, full) => a != null && full != null && (a === full || (String(a).length >= 8 && HEX_PREFIX.test(String(a)) && String(full).startsWith(String(a))));
/** Task statuses that mean the task died (as opposed to ending by itself). */
export const DEAD_TASK_STATUSES = Object.freeze(['failed', 'cancelled', 'canceled', 'timeout', 'timed_out', 'error']);

const sec = (ms) => Math.floor(ms / 1000);
const msOf = (iso) => { const n = Date.parse(iso); return Number.isFinite(n) ? n : null; };
const id8 = (id) => String(id ?? '?').slice(0, 8);
const stage = (status, detail, evidence = [], reason = undefined) => (reason === undefined ? { status, detail, evidence } : { status, detail, evidence, reason });   // `reason` (R12 only): a machine-readable class of the verdict (operator-died, operator-stopped, out-of-repo-pick, ...)
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
 * @param {'mcp'|'cli'} [a.access]  how the operator reaches the backlog: 'mcp' (R11, default, byte-identical behaviour) or 'cli' (R12: `adhd-backlog` in the shell tool; S1 is the selection stage of SCOPE-R12-schema-and-scope, the S5 transition match reads CLI calls). With 'cli', `item` is the transitionFactCli() fact (project/component/in-repo/non-terminal/unblocked per picked item).
 * @returns {{stages:Record<string,{status:'pass'|'fail'|'unknown', detail:string, evidence:string[]}>, flowComplete:boolean, firstNotPassed:string|null, line:string}}
 */
export function detectFlow({ tasks, commits, item, agents = AGENT_NAMES, access = 'mcp' }) {
  const A = { ...AGENT_NAMES, ...agents };
  const cli = access === 'cli';
  // how one task call reads as a backlog transition, and which item it acts on (R11: the MCP tool name + its envelope uid; R12: the parsed `adhd-backlog transition` shell call)
  const isTr = (c) => (cli ? parseCliCall(c)?.verb === 'transition' && cliOutcome(c).ok : isTransition(c) && c.isError !== true);
  const trUid = (c) => (cli ? parseCliCall(c)?.uid ?? null : uidOf(c.input));
  const sameItem = (callUid, picked) => (cli ? sameUid(callUid, picked) : callUid === picked);
  const stages = {};
  const T = Array.isArray(tasks) ? tasks : null;
  const C = Array.isArray(commits) ? commits : null;
  const opTasks = T ? T.filter((t) => t.agent === A.operator && t.parentTaskId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
  const firstOp = opTasks?.[0] ?? null;
  const reviewTasks = T ? T.filter((t) => t.agent === A.reviewer && t.parentTaskId && (!firstOp || (msOf(t.createdAt) ?? 0) >= (msOf(firstOp.createdAt) ?? 0))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : null;
  const review = reviewTasks?.[0] ?? null;

  // S1 ----------------------------------------------------------------------------------------------------------------
  if (cli) stages.S1 = selectionStageCli({ T, firstOp, opTasks, item, A });
  else if (!T) stages.S1 = stage('unknown', 'no agent-mcp task records were captured');
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
    const transitions = afterRev.flatMap((t) => (t.calls ?? []).filter((c) => isTr(c) && (!picked || sameItem(trUid(c), picked))).map((c) => ({ t, c })));
    const sameSession = firstOp.sessionId != null && afterRev.some((t) => t.sessionId === firstOp.sessionId);
    const allTransitionTasks = (opTasks ?? []).filter((t) => (t.calls ?? []).some((c) => isTr(c)));
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


/**
 * R12 AC2: the selection stage, read from state. PASS needs ALL of: the backlog-operator was dispatched through agent-mcp; a specific item uid was selected (it appears in a successful
 * `adhd-backlog` get / claim / transition call of the operator's task record, never in a query result); the item belongs to THIS repository's backlog project; and it was non-terminal and
 * unblocked in the before-snapshot. An item of another project is FAIL "out-of-repo pick" naming uid, project and component. An operator that died (task failed / cancelled / timed out) before
 * selecting anything is FAIL naming the failing step; one that completed without selecting is FAIL "stopped". Absent data is unknown, never pass.
 */
function selectionStageCli({ T, firstOp, opTasks, item, A }) {
  if (!T) return stage('unknown', 'no agent-mcp task records were captured');
  if (!firstOp) return stage('fail', `no ${A.operator} task was dispatched through agent-mcp (no child task of agent ${A.operator})`, T.map(taskRef), 'operator-not-dispatched');
  const ev = [taskRef(firstOp)];
  const cliCalls = (opTasks ?? []).flatMap((t) => (t.calls ?? []).map((c) => ({ t, c, p: parseCliCall(c) }))).filter((x) => x.p);
  const okCalls = cliCalls.filter((x) => cliOutcome(x.c).ok);
  const dead = (opTasks ?? []).find((t) => DEAD_TASK_STATUSES.includes(t.status)) ?? null;
  if (!item || !item.picked) {
    if (dead) {
      const calls = dead.calls ?? []; const last = calls.at(-1); const bad = [...calls].reverse().find((c) => c.isError === true);
      return stage('fail', `${A.operator} died before selecting an item: ${taskRef(dead)} ended ${dead.status}${dead.error ? ` (${String(dead.error).replace(/\s+/g, ' ')})` : ''}; ${okCalls.length} successful adhd-backlog call(s) before it ended; failing step: ${last ? `last tool call ${last.name}${bad ? `, last tool error ${errorSnippet(bad.resultText ?? '')}` : ''}` : 'it made no tool call (the first model request failed)'}`, [taskRef(dead)], 'operator-died');
    }
    if (item === null || item === undefined) return stage('unknown', `${A.operator} was dispatched but the backlog read-back is not available`, ev);
    return stage('fail', `${A.operator} stopped without selecting an item: ${taskRef(firstOp)} ${firstOp.status}, ${cliCalls.length} adhd-backlog call(s) (${okCalls.length} successful), none was a successful get / claim / transition naming an item uid`, ev, 'operator-stopped');
  }
  ev.push(`item ${item.picked}`);
  if (item.inRepo === false) return stage('fail', `out-of-repo pick: item ${item.picked} belongs to project ${item.projectName ?? item.project ?? '?'}, component ${item.componentName ?? item.component ?? '?'}; this repository's backlog project is ${item.repoProject?.name ?? item.repoProject?.uid ?? '?'}`, ev, 'out-of-repo-pick');
  if (item.inRepo !== true) return stage('unknown', `item ${item.picked} was selected but its project could not be classified as in-repo or out-of-repo (${item.inRepoNote ?? 'project or repository project unresolved'})`, ev, 'project-unresolved');
  if (item.nonTerminalBefore === false) return stage('fail', `item ${item.picked} is in this repository's project but was not a non-terminal item in the before-snapshot (terminal before the run, or not in the snapshot)`, ev, 'terminal-before');
  if (item.unblockedBefore === false) return stage('fail', `item ${item.picked} was blocked in the before-snapshot (${(item.blockersBefore ?? []).map((b) => `${String(b.uid).slice(0, 8)} ${b.status ?? '?'}`).join(', ') || 'blockers recorded'})`, ev, 'blocked-before');
  if (item.nonTerminalBefore !== true || item.unblockedBefore !== true) return stage('unknown', `item ${item.picked} is in this repository's project but the before-snapshot cannot confirm it was non-terminal and unblocked (${item.beforeNote ?? 'snapshot incomplete or failed'})`, ev, 'before-unconfirmed');
  return stage('pass', `${A.operator} dispatched through agent-mcp; item ${item.picked} selected through a successful adhd-backlog ${item.pickedVia ?? 'call'} (project ${item.projectName ?? item.project}, component ${item.componentName ?? item.component}; ${item.statusBefore ?? '?'} and unblocked in the before-snapshot)`, [...ev, `item ${item.picked} in this repository's project, non-terminal and unblocked before`], 'selected');
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

/**
 * R12 AC4: tool failures classified, so one harmless probe does not inflate a real repeated error (R11 B1: the matcher above counted 4 "errors" for the shell tool: three engine-marked
 * `Unexpected shell operator` errors plus one `ls ... [exit status: 1]` probe, because it counts isError OR an ERROR_LIKE text under ONE key per (task, tool)).
 *  - 'tool-error': the engine marked the call an error (the call never ran: policy rejection, bad arguments, timeout)
 *  - 'refusal':    the command ran and was refused (sandbox, permission, hook, git fatal)
 *  - 'nonzero-exit': the command ran and exited non-zero (often an ordinary probe: `ls` of a missing path)
 * Each call is classified once; groups are per (task, tool, class, signature) where the signature is the error message cut at its second colon, digits removed.
 * @returns {null|{cls:'tool-error'|'refusal'|'nonzero-exit', signature:string, sample:string}}
 */
export function classifyToolError(c) {
  const text = String(c?.resultText ?? '');
  const sample = errorSnippet(text || '(no result text recorded)');
  const sig = (t) => { const m = String(t).replace(/^Tool '[^']*' on server '[^']*' returned an error:\s*\[\{"type":"text","text":"/, '').replace(/\d+/g, 'N').split(':').slice(0, 2).join(':').trim().slice(0, 90); return m || 'error'; };
  if (c?.isError === true) return { cls: ERROR_LIKE.test(text) && !/\[exit status:/.test(text) ? 'refusal' : 'tool-error', signature: sig(text), sample };
  if (/\[exit status: [1-9]\d*\]/.test(text)) return { cls: 'nonzero-exit', signature: sig(text.replace(/\s*\[exit status: \d+\]\s*$/, '')), sample };
  if (ERROR_LIKE.test(text)) return { cls: 'refusal', signature: sig(text), sample };
  return null;
}
/**
 * Groups of identical failures per task and tool, `threshold` or more calls each (default 2). `bugCandidate` is true for the classes the owner rule "repeated tool errors are bugs" covers
 * (tool-error, refusal); a repeated non-zero exit is reported but is not by itself a bug candidate.
 * @returns {Array<{taskId:string, agent:string|null, tool:string, cls:string, signature:string, count:number, sample:string, bugCandidate:boolean}>}
 */
export function toolErrorGroups(tasks, { threshold = 2 } = {}) {
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const by = new Map();
    for (const c of t.calls ?? []) {
      const k = classifyToolError(c); if (!k) continue;
      const key = `${c.name}\u0000${k.cls}\u0000${k.signature}`; const e = by.get(key) ?? { tool: c.name, ...k, count: 0 }; e.count++; by.set(key, e);
    }
    for (const e of by.values()) if (e.count >= threshold) out.push({ taskId: t.taskId, agent: t.agent ?? null, tool: e.tool, cls: e.cls, signature: e.signature, count: e.count, sample: e.sample, bugCandidate: e.cls !== 'nonzero-exit' });
  }
  return out;
}
/**
 * R12 AC4: the bug candidates of one group, kept apart: `operatorDied` (a backlog-operator task ended failed / cancelled / timed out), `operatorStopped` (an operator task completed but the
 * selection stage reports it selected nothing), `repeatedToolErrors` (toolErrorGroups with bugCandidate). `any` is true when one of them is set.
 */
export function bugCandidates({ tasks, flow, agents = AGENT_NAMES }) {
  const A = { ...AGENT_NAMES, ...agents };
  const ops = (Array.isArray(tasks) ? tasks : []).filter((t) => t.agent === A.operator);
  const died = ops.filter((t) => DEAD_TASK_STATUSES.includes(t.status)).map((t) => ({ taskId: t.taskId, status: t.status, error: t.error ?? null }));
  const stopped = flow?.stages?.S1?.reason === 'operator-stopped' ? ops.filter((t) => !DEAD_TASK_STATUSES.includes(t.status)).slice(0, 1).map((t) => ({ taskId: t.taskId, status: t.status })) : [];
  const repeated = toolErrorGroups(tasks).filter((g) => g.bugCandidate);
  return { operatorDied: died, operatorStopped: stopped, repeatedToolErrors: repeated, any: died.length > 0 || stopped.length > 0 || repeated.length > 0 };
}
