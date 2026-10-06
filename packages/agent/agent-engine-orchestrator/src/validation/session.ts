import { z } from 'zod';

export const sessionStatusSchema = z.enum(['active', 'closed']);
export type { SessionStatus } from '@adhd/agent-base-types';

export const sessionSchema = z.object({
  id: z.string().uuid(),
  agentName: z.string(),
  agentVersion: z.number().int().positive(),
  status: sessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export type { Session } from '@adhd/agent-base-types';

export const agentToolInputSchema = z.object({
  name: z.string().min(1),
  /**
   * Caller-supplied cwd (ADR-0008 D4; caller-cwd contract). Anchors the
   * session's native-tooling resolution and — on a sub-dispatch — inherits the
   * dispatching parent's cwd. Absent ⇒ host `process.cwd()` (flagged).
   */
  cwd: z.string().optional(),
});

export const agentToolOutputSchema = z.object({
  session_id: z.string().uuid(),
});

export const sessionListInputSchema = z.object({
  agentName: z.string().optional(),
  status: sessionStatusSchema.optional(),
});

export const sessionCloseInputSchema = z.object({
  session_id: z.string().uuid(),
});

/**
 * `session_update` — swap the session-held provider binding (the `session` tier
 * of the selection chain). At least one of `provider` / `model` / `models`.
 * `model` and `models` take canonical refs (e.g. `claude_sonnet_4_6`).
 */
export const sessionUpdateInputSchema = z
  .object({
    session_id: z.string().uuid(),
    provider: z.enum(['anthropic', 'openai', 'claudecli']).optional(),
    model: z.string().min(1).optional(),
    models: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((v) => v.provider !== undefined || v.model !== undefined || v.models !== undefined, {
    message: 'session_update needs at least one of provider, model, models',
  });

export const sessionClearInputSchema = z.object({
  session_id: z.string().uuid(),
});

export const sessionClearOutputSchema = z.object({
  session_id: z.string().uuid(),
  cleared: z.number().int().nonnegative(),
});

export type AgentToolInput = z.infer<typeof agentToolInputSchema>;
export type AgentToolOutput = z.infer<typeof agentToolOutputSchema>;
export type SessionListInput = z.infer<typeof sessionListInputSchema>;
export type SessionCloseInput = z.infer<typeof sessionCloseInputSchema>;
export type SessionUpdateInput = z.infer<typeof sessionUpdateInputSchema>;
export type SessionClearInput = z.infer<typeof sessionClearInputSchema>;
export type SessionClearOutput = z.infer<typeof sessionClearOutputSchema>;
