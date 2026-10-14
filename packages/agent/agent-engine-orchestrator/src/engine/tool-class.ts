/**
 * `tool-class.ts` — same-turn tool-call concurrency classification (R10 S2 / P1).
 *
 * When a model emits several tool calls in ONE assistant turn, the engine used to start them all
 * at once. That is wrong for a write followed by a read of the same file: the read could be
 * answered before the write landed (R9 C1: `fs__edit_file` + `fs__read_text_file` in one turn
 * returned stale text; backlog d8e157cd). The deterministic rule, the same one Claude Code
 * applies, is: reads run in parallel, anything that may mutate runs alone and in order.
 *
 * This module is the PURE half of that rule: it names each call's class. The scheduling half is
 * `IToolLimiter.mapOrdered` (`tool-limiter.ts`).
 *
 * Classes
 * - `safe`      reads. Runs in parallel with every other `safe` call, but never starts before an
 *               EARLIER barrier has settled.
 * - `barrier`   writes, edits, shell. Starts only after every EARLIER ordered call (safe or
 *               barrier) in the turn has settled, and every LATER ordered call waits for it.
 * - `unordered` delegation tools (see {@link DELEGATION_TOOL_NAMES}). They are not gated by, and
 *               do not gate, any other call: a `task` runs for minutes and must keep overlapping
 *               the `make test` emitted beside it (R9 C1, phase 2). {@link classifyTool} reports
 *               them as `safe` (the answer to "may this run beside reads"); the scheduler asks
 *               {@link schedulingClassOf} to learn that they are also never ordered.
 *
 * Rules (first match wins)
 *  1. `shell__shell_execute`                          -> barrier (an argv shell cannot be classified)
 *  2. `agent-mcp__{agent,task,tasks_batch,result,task_cancel,task_resume}` -> safe / unordered
 *  3. any other `agent-mcp__*` (session_*, usage_query, pricing_*, guide, task_list) ->
 *     `readOnlyHint === true ? safe : barrier` (they mutate shared stores; they are rare and cheap,
 *     so ordering them costs nothing)
 *  4. `annotations.readOnlyHint === true`  -> safe
 *  5. `annotations.readOnlyHint === false` -> barrier
 *  6. no `readOnlyHint`: the builtin `fs` / `shell` servers -> barrier (the pinned fs server
 *     annotates every tool, so this branch is only reachable if a future version drops them; the
 *     registry warns at startup); every other server -> safe (today's behaviour: a third-party
 *     tool that declares nothing is not ordered, so third-party WRITE tools stay racy unless the
 *     server advertises `readOnlyHint: false`).
 */
import { TOOL_NAME_SEPARATOR } from '../clients/tool-naming.js';
import type { ToolDefinition } from '../providers/types.js';

/** A call's ordering class. */
export type ToolConcurrencyClass = 'safe' | 'barrier';

/** What the scheduler sees: a {@link ToolConcurrencyClass} or `unordered` (never gated, never gates). */
export type ToolSchedulingClass = ToolConcurrencyClass | 'unordered';

/** agent-mcp's own server key (as in `DISPATCH_SERVER_KEY` of agent-core-native-tooling). */
const DISPATCH_SERVER = 'agent-mcp';
/** The builtin shell server key and its single execute tool. */
const SHELL_SERVER = 'shell';
const SHELL_EXECUTE_TOOL = 'shell_execute';
/** The builtin file-system server key. */
const FS_SERVER = 'fs';

/**
 * agent-mcp tools that hand work to (or read the state of) a child task. They are never ordered:
 * each runs in its own task with its own limiter, and `result` merely waits for one.
 */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'agent',
  'task',
  'tasks_batch',
  'result',
  'task_cancel',
  'task_resume',
]);

/** Splits `server__tool` at the first separator. A name without one is its own server and tool. */
export function splitQualifiedToolName(qualifiedName: string): { server: string; tool: string } {
  const i = qualifiedName.indexOf(TOOL_NAME_SEPARATOR);
  return i === -1
    ? { server: qualifiedName, tool: qualifiedName }
    : { server: qualifiedName.slice(0, i), tool: qualifiedName.slice(i + TOOL_NAME_SEPARATOR.length) };
}

/** True for an agent-mcp delegation tool ({@link DELEGATION_TOOL_NAMES}) given its qualified name. */
export function isDelegationTool(qualifiedName: string): boolean {
  const { server, tool } = splitQualifiedToolName(qualifiedName);
  return server === DISPATCH_SERVER && DELEGATION_TOOL_NAMES.has(tool);
}

/**
 * The concurrency class of one tool call.
 *
 * @param qualifiedName the advertised `server__tool` name
 * @param def the advertised definition (its `annotations.readOnlyHint` is read), when known
 */
export function classifyTool(qualifiedName: string, def?: ToolDefinition): ToolConcurrencyClass {
  const { server, tool } = splitQualifiedToolName(qualifiedName);
  if (server === SHELL_SERVER && tool === SHELL_EXECUTE_TOOL) return 'barrier';
  if (server === DISPATCH_SERVER && DELEGATION_TOOL_NAMES.has(tool)) return 'safe';
  const hint = def?.annotations?.readOnlyHint;
  if (server === DISPATCH_SERVER) return hint === true ? 'safe' : 'barrier';
  if (hint === true) return 'safe';
  if (hint === false) return 'barrier';
  return server === FS_SERVER || server === SHELL_SERVER ? 'barrier' : 'safe';
}

/**
 * The class the scheduler orders by: `unordered` for a delegation tool, otherwise `classOf`
 * (default {@link classifyTool}). `classOf` lets a caller substitute a registry-provided class
 * for the tool-definition lookup without re-implementing the delegation exemption.
 */
export function schedulingClassOf(
  qualifiedName: string,
  def?: ToolDefinition,
  classOf: (qualifiedName: string, def?: ToolDefinition) => ToolConcurrencyClass = classifyTool
): ToolSchedulingClass {
  return isDelegationTool(qualifiedName) ? 'unordered' : classOf(qualifiedName, def);
}

/**
 * Numbers the ordered execution groups of one turn: a contiguous run of `safe` calls shares one
 * group, every `barrier` is its own group, and groups count up from 0 in submission order. An
 * `unordered` call takes the group of the nearest ordered call before it (0 when none), because it
 * runs beside that group and belongs to none.
 *
 * This is the single numbering used both by the scheduler (`mapOrdered`) and by the engine when it
 * reports a call's planned `groupIndex`.
 */
export function assignGroups(classes: readonly ToolSchedulingClass[]): number[] {
  const out: number[] = [];
  let group = -1;
  let previous: ToolConcurrencyClass | undefined;
  for (const cls of classes) {
    if (cls === 'unordered') {
      out.push(Math.max(group, 0));
      continue;
    }
    if (cls === 'barrier' || previous !== 'safe') group += 1;
    previous = cls;
    out.push(group);
  }
  return out;
}
