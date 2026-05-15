import { z } from "zod";

export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const toolCallSchema = z.object({
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});

export const toolResultSchema = z.object({
  toolCallId: z.string(),
  result: z.unknown(),
  isError: z.boolean().default(false),
});

export const messageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: messageRoleSchema,
  content: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolResults: z.array(toolResultSchema).optional(),
  createdAt: z.string().datetime(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type Message = z.infer<typeof messageSchema>;
