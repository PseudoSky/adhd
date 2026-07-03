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
});

const ephemeralModeSchema = z.object({
  agent_name: z.string().min(1),
  prompt: z.string().min(1),
  depends_on: z.array(z.string().uuid()).optional(),
  on_upstream_failure: z.enum(['fail', 'skip']).optional(),
  stream: z.boolean().optional(),
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

export const taskListInputSchema = z.object({
  session_id: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  is_ephemeral: z.boolean().optional(),
});

export const taskCancelInputSchema = z.object({
  task_id: z.string().uuid(),
});

export const resultInputSchema = z.object({
  task_id: z.string().uuid(),
});

export type TaskToolInput = z.infer<typeof taskToolInputSchema>;
export type TaskToolOutput = z.infer<typeof taskToolOutputSchema>;
export type TaskListInput = z.infer<typeof taskListInputSchema>;
export type TaskCancelInput = z.infer<typeof taskCancelInputSchema>;
export type ResultInput = z.infer<typeof resultInputSchema>;
