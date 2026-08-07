import { z } from 'zod';
import { agentDefinitionSchema } from './agent.js';

export const executionContextSchema = z.object({
  taskId: z.string().uuid(),
  sessionId: z.string().uuid(),
  agentName: z.string(),
  agentDefinition: agentDefinitionSchema,
  callingAgentName: z.string().optional(),
  parentTaskId: z.string().uuid().optional(),
  recursionDepth: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  inputs: z.record(z.string(), z.string()).optional(),
});

export type { ExecutionContext } from '@adhd/agent-base-types';
