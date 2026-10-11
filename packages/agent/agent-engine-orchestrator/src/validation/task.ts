import { z } from 'zod';

import { taskUsageReportSchema } from './usage.js';

export const taskStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'waiting',
  'awaiting_input',
]);

export type { TaskStatus } from '@adhd/agent-base-types';

export const taskSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  isEphemeral: z.boolean().default(false),
  parentTaskId: z.string().uuid().optional(),
  recursionDepth: z.number().int().nonnegative(),
  status: taskStatusSchema,
  prompt: z.string(),
  result: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  cancelledAt: z.string().datetime().optional(),
  dependsOn: z.array(z.string().uuid()).optional().nullable(),
  onUpstreamFailure: z.enum(['fail', 'skip']).optional().nullable(),
  inputs: z.record(z.string(), z.string()).optional().nullable(),
  resumeToken: z.string().uuid().optional().nullable(),
});

export type { Task } from '@adhd/agent-base-types';

export const taskEventTypeSchema = z.enum([
  'MODEL_REQUEST',
  'MODEL_RESPONSE',
  'TOOL_CALL',
  'TOOL_RESULT',
  'TOOL_ARG_COERCED',
  'budget:unpriced_model',
  'provider:builtin_bypass',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED',
]);

export type { TaskEventType } from '@adhd/agent-base-types';

export const taskEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  type: taskEventTypeSchema,
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});

export type { TaskEvent } from '@adhd/agent-base-types';

const sessionModeSchema = z.object({
  session_id: z.string().uuid(),
  prompt: z.string().min(1),
  background: z.boolean().default(false),
  depends_on: z.array(z.string().uuid()).optional(),
  on_upstream_failure: z.enum(['fail', 'skip']).optional(),
  stream: z.boolean().optional(),
  /**
   * Caller-supplied cwd (ADR-0008 D4; caller-cwd contract). Anchors the task's
   * native-tooling resolution (fs/shell roots) and a sub-dispatch's inherited
   * cwd. Absent ⇒ inherit the dispatching parent's cwd, else fall back to the
   * host's `process.cwd()` (flagged).
   */
  cwd: z.string().optional(),
});

const ephemeralModeSchema = z.object({
  agent_name: z.string().min(1),
  prompt: z.string().min(1),
  depends_on: z.array(z.string().uuid()).optional(),
  on_upstream_failure: z.enum(['fail', 'skip']).optional(),
  stream: z.boolean().optional(),
  /** Caller-supplied cwd (ADR-0008 D4; caller-cwd contract). See sessionModeSchema. */
  cwd: z.string().optional(),
});

export const taskToolInputSchema = z.union([
  sessionModeSchema,
  ephemeralModeSchema,
]);

export const taskToolOutputSchema = z.object({
  task_id: z.string().uuid(),
  status: taskStatusSchema,
  result: z.string().optional(),
  stream_url: z.string().optional(),
  usage: taskUsageReportSchema.optional(),
});

/**
 * The fields a `task_list` / `result` caller may project onto (f2b004eb). `id` is
 * always included; `prompt` and `result` are the two large text fields callers most
 * often drop when bulk-polling — an unprojected list routinely exceeded the caller's
 * tool-output token budget because it returned every matching task's full text.
 */
export const taskListFieldSchema = z.enum([
  'id',
  'sessionId',
  'isEphemeral',
  'parentTaskId',
  'recursionDepth',
  'status',
  'prompt',
  'result',
  'error',
  'createdAt',
  'updatedAt',
  'completedAt',
  'cancelledAt',
  'dependsOn',
  'onUpstreamFailure',
  'inputs',
  'resumeToken',
]);
export type TaskListField = z.infer<typeof taskListFieldSchema>;

export const taskListInputSchema = z.object({
  session_id: z.string().uuid().optional(),
  /** df109078: plural, OR-matched session filter (track one batch without a
   *  full-instance scan filtered client-side). */
  session_ids: z.array(z.string().uuid()).optional(),
  /** df109078: only the tasks of this agent (via the task's session). */
  agent_name: z.string().min(1).optional(),
  status: taskStatusSchema.optional(),
  is_ephemeral: z.boolean().optional(),
  /** f2b004eb: return only these fields per task (id always included). */
  fields: z.array(taskListFieldSchema).optional(),
  /** f2b004eb: shorthand for all fields EXCEPT the bulk `prompt`/`result` text. */
  summary: z.boolean().optional(),
  /** f2b004eb: page size / offset (applied after deterministic ordering). */
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const taskCancelInputSchema = z.object({
  task_id: z.string().uuid(),
});

export const resultInputSchema = z.object({
  task_id: z.string().uuid(),
  /** f2b004eb: project the returned task record (id always included). The special
   *  value `usage` may be named to keep the usage report; omit `fields` for the full
   *  task + usage payload. */
  fields: z.array(z.union([taskListFieldSchema, z.literal('usage')])).optional(),
});

export type TaskToolInput = z.infer<typeof taskToolInputSchema>;
export type TaskToolOutput = z.infer<typeof taskToolOutputSchema>;
export type TaskListInput = z.infer<typeof taskListInputSchema>;
export type TaskCancelInput = z.infer<typeof taskCancelInputSchema>;
export type ResultInput = z.infer<typeof resultInputSchema>;

/**
 * Tolerance pre-step for `tasks_batch.concurrency` (backlog 932604a0 R9): a
 * model may send the integer as a base-10 string (`"2"`). Only a string that
 * is exactly an optionally-signed run of digits is converted; anything else
 * (`"abc"`, `"2.5"`, `""`) is passed through untouched so the strict number
 * schema still rejects it. Range checks (positive, max 64) stay in the schema.
 *
 * @param value - the raw `concurrency` argument.
 * @returns the number for an integer string, otherwise `value` unchanged.
 */
function parseIntegerString(value: unknown): unknown {
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
    return Number(value);
  }
  return value;
}

/**
 * Tolerance pre-step for `tasks_batch.prompts` (backlog 932604a0 R9): a model
 * may send the array as a JSON string. Only a string that `JSON.parse`s to an
 * array is replaced; malformed JSON or a non-array JSON value is passed
 * through untouched so the strict array schema rejects it. Element rules
 * (non-empty strings, non-empty array) stay in the schema.
 *
 * @param value - the raw `prompts` argument.
 * @returns the decoded array for a stringified array, otherwise `value`.
 */
function parseStringifiedArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * `tasks_batch` (FEAT: native bulk/parallel task-dispatch primitive,
 * backlog 05cc1db4). Fans out N prompts in ONE call, honoring a concurrency
 * cap, so the caller never hand-maintains a session_id↔task_id mapping or
 * hand-builds a `depends_on` chain for the common "N independent items,
 * throttled" case.
 *
 * Exactly one of `agent_name` (one-shot ephemeral per prompt — sessions are
 * created internally) or `session_ids` (reuse an existing session per prompt)
 * must be supplied. Per-item `depends_on` (pre-existing task ids) and
 * `depends_on_indexes` (earlier items *within this batch*, resolved to the
 * generated task ids) compose with the existing DAG ordering fields.
 */
export const tasksBatchInputSchema = z
  .object({
    agent_name: z
      .string()
      .min(1)
      .optional()
      .describe('Ephemeral one-shot agent for every prompt (mutually exclusive with session_ids)'),
    session_ids: z
      .array(z.string().uuid())
      .optional()
      .describe('Reuse one existing session per prompt; length must equal prompts.length'),
    prompts: z.preprocess(
      parseStringifiedArray,
      z.array(z.string().min(1)).min(1).describe('One prompt per dispatched task')
    ),
    concurrency: z.preprocess(
      parseIntegerString,
      z
        .number()
        .int()
        .positive()
        .max(64)
        .optional()
        .describe('Max tasks executing simultaneously (default 4)')
    ),
    depends_on: z
      .array(z.array(z.string().uuid()))
      .optional()
      .describe('Per-item pre-existing upstream task ids; length must equal prompts.length'),
    depends_on_indexes: z
      .array(z.array(z.number().int().nonnegative()))
      .optional()
      .describe(
        'Per-item indexes of EARLIER items in this batch this task depends on; each index must be < its item index'
      ),
    on_upstream_failure: z
      .array(z.enum(['fail', 'skip']))
      .optional()
      .describe('Per-item upstream-failure policy; length must equal prompts.length'),
  })
  .superRefine((val, ctx) => {
    const n = val.prompts.length;
    const hasAgent = val.agent_name !== undefined;
    const hasSessions = val.session_ids !== undefined;
    if (hasAgent === hasSessions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of agent_name or session_ids must be supplied',
      });
    }
    if (val.session_ids && val.session_ids.length !== n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `session_ids.length (${val.session_ids.length}) must equal prompts.length (${n})`,
      });
    }
    const parallel = (name: string, arr: unknown[] | undefined) => {
      if (arr && arr.length !== n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name}.length (${arr.length}) must equal prompts.length (${n})`,
        });
      }
    };
    parallel('depends_on', val.depends_on);
    parallel('depends_on_indexes', val.depends_on_indexes);
    parallel('on_upstream_failure', val.on_upstream_failure);

    val.depends_on_indexes?.forEach((deps, i) => {
      for (const j of deps) {
        if (j >= i) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['depends_on_indexes', i],
            message: `item ${i} may only depend on an earlier index (< ${i}); got ${j}`,
          });
        }
      }
    });
  });

export type TasksBatchInput = z.infer<typeof tasksBatchInputSchema>;

export const tasksBatchOutputSchema = z.object({
  concurrency: z.number().int().positive(),
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      task_id: z.string().uuid(),
      status: taskStatusSchema,
      result: z.string().optional(),
    })
  ),
});

export type TasksBatchOutput = z.infer<typeof tasksBatchOutputSchema>;
