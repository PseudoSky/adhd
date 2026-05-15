import { z } from "zod";

export const sessionStatusSchema = z.enum(["active", "closed"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// Public session shape — agentData is intentionally absent (storage-only)
export const sessionSchema = z.object({
  id: z.string().uuid(),
  agentName: z.string(),
  agentVersion: z.number().int().positive(),
  status: sessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

// Tool input schemas
export const agentToolInputSchema = z.object({
  name: z.string().min(1),
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
export type SessionClearInput = z.infer<typeof sessionClearInputSchema>;
export type SessionClearOutput = z.infer<typeof sessionClearOutputSchema>;
