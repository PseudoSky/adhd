import { z } from "zod";

// McpServerConfig — matches standard MCP format (claude_desktop_config.json / .mcp.json)
// Transport discriminator is at top level of each union member

const mcpStdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const mcpHttpConfigSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const mcpSseConfigSchema = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  mcpStdioConfigSchema,
  mcpHttpConfigSchema,
  mcpSseConfigSchema,
]);

export type McpStdioConfig = z.infer<typeof mcpStdioConfigSchema>;
export type McpHttpConfig = z.infer<typeof mcpHttpConfigSchema>;
export type McpSseConfig = z.infer<typeof mcpSseConfigSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
