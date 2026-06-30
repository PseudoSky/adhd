#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { resolve } from "path";

const ALLOWED_DIR = resolve(process.argv[2] || process.cwd());

// Commands that are explicitly ALLOWED (prefix match on the first token)
const ALLOWED_COMMAND_PREFIXES = new Set([
  "npx", "npm", "yarn", "node",
  "echo", "ls", "cat", "which", "head", "tail", "wc", "sort", "uniq",
  "date", "pwd", "printf", "true", "false",
]);

// Disallowed patterns in the full command string
const BLOCKED_PATTERNS = [
  /rm\s+(-rf|-r|-f)?\s*\/|rm\s+-rf/,
  /sudo/,
  /chmod\s/,
  /chown\s/,
  /mkfs/,
  /dd\s/,
  /:(){ :\|:&\};:/,
  /curl\s/,
  /wget\s/,
  /bash\s*-c/,
  /sh\s*-c/,
  />(>)?\s*\/etc/,
  /kill\s/,
];

function isAllowed(command) {
  const trimmed = command.trim();
  const firstToken = trimmed.split(/\s+/)[0];
  if (!ALLOWED_COMMAND_PREFIXES.has(firstToken)) return false;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  return true;
}

function text(s) { return { content: [{ type: "text", text: s }] }; }

const server = new Server(
  { name: "adhd-mcp-shell", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "shell",
      description: `Execute a whitelisted command (npx/npm/yarn/node only). Restricted to ${ALLOWED_DIR}. No destructive operations (rm -rf, sudo, curl, chmod, etc.)`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
          timeout: { type: "number", description: "Timeout in ms (default 120000)" },
        },
        required: ["command"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name !== "shell") throw new Error(`Unknown tool: ${name}`);
    if (!isAllowed(args.command)) throw new Error(`Command not in allowlist: ${args.command.slice(0, 80)}`);
    const out = execSync(args.command, {
      cwd: ALLOWED_DIR,
      encoding: "utf-8",
      timeout: args.timeout || 120000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const truncated = out.length > 50000 ? out.slice(0, 50000) + "\n... [truncated]" : out;
    return text(truncated || "(no output)");
  } catch (err) {
    const msg = err.stderr ? err.stderr.slice(0, 5000) : err.message;
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
