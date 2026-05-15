import { z } from "zod";

export const taskStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
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
});

export type Task = z.infer<typeof taskSchema>;

export const taskEventTypeSchema = z.enum([
  "MODEL_REQUEST",
  "MODEL_RESPONSE",
  "TOOL_CALL",
  "TOOL_RESULT",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
]);

export type TaskEventType = z.infer<typeof taskEventTypeSchema>;

export const taskEventSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  type: taskEventTypeSchema,
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});

export type TaskEvent = z.infer<typeof taskEventSchema>;

// Tool input/output schemas
export const taskToolInputSchema = z.object({
  session_id: z.string().uuid(),
  prompt: z.string().min(1),
  background: z.boolean().default(false),
});

export const taskToolOutputSchema = z.object({
  task_id: z.string().uuid(),
  status: taskStatusSchema,
  result: z.string().optional(),
});

export const taskListInputSchema = z.object({
  session_id: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
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
