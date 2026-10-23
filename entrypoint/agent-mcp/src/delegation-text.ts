/**
 * delegation-text.ts — the ONE source of the sync-versus-background decision rule that every delegation
 * description leads with (R10 S4, P6a).
 *
 * The rule is stated first, in the same words, in all six tool descriptions that carry it (`task`,
 * `tasks_batch` and `result` in the in-process descriptors a delegated model sees, and `task`, `tasks_batch` and
 * `result` in the host tool list)
 * and in the usage guide, so the sites cannot drift apart. It is accurate for today's behaviour: a
 * background task's result is NOT delivered to the caller automatically; the caller has to fetch it with
 * `result` before its answer depends on it.
 *
 * Text only. No input schema, default or response shape depends on this constant.
 */
export const DELEGATION_DECISION_RULE =
  'task and tasks_batch are synchronous by default and return the finished result. ' +
  'Use background:true only when you have independent work to do meanwhile; a background result is NOT ' +
  'delivered automatically, so you MUST call result (with wait_ms) to collect it before your answer depends on it. ' +
  'Do not give a background worker files you are editing yourself.';
