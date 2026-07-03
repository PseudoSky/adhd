import { z } from 'zod';
import type { SessionStatus } from '@adhd/agent-base-types';

// ── Session ──────────────────────────────────────────────────────────

export const sessionSchema = z.object({
  id: z.string().uuid(),
  agentName: z.string(),
  agentVersion: z.number().int().positive(),
  status: z.enum(['active', 'closed']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export type { Session } from '@adhd/agent-base-types';

export type SessionListInput = {
  agentName?: string;
  status?: SessionStatus;
};

// ── AgentDefinition (stored) ─────────────────────────────────────────
// Minimal structural validation for stored agent snapshots.
// The full provider discriminator with legacy shim lives in agent-mcp;
// here we validate only the top-level shape the store writes/reads.

export const agentDefinitionStoredSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.number().int().positive(),
    provider: z
      .object({
        type: z.enum(['anthropic', 'openai', 'claudecli']),
      })
      .passthrough(),
    systemPrompt: z.string().optional(),
    mcpServers: z.record(z.string(), z.unknown()).default({}),
    permissions: z
      .object({ allowedAgents: z.array(z.string()).optional() })
      .default({}),
    maxToolLoops: z.number().int().positive().optional(),
    allowHumanInput: z.boolean().optional(),
    sanitization: z.enum(['none', 'prefix', 'wrap']).optional(),
    toolAdvertisement: z.enum(['names', 'full']).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

export type { AgentDefinition } from '@adhd/agent-base-types';

// ── Message ──────────────────────────────────────────────────────────

export type { Message } from '@adhd/agent-base-types';

// ── Task ─────────────────────────────────────────────────────────────

export const taskSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  isEphemeral: z.boolean().default(false),
  parentTaskId: z.string().uuid().optional(),
  recursionDepth: z.number().int().nonnegative(),
  status: z.enum([
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
    'waiting',
    'awaiting_input',
  ]),
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

export type { Task, TaskStatus, TaskEventType } from '@adhd/agent-base-types';

export type TaskListInput = {
  session_id?: string;
  status?: z.infer<typeof taskSchema>['status'];
  is_ephemeral?: boolean;
};
