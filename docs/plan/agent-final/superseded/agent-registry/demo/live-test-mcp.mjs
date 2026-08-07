// Live end-to-end test of the NEW agent-mcp build over real MCP stdio + a real
// claudecli model. Spawns the worktree dist server, drives agent_create → agent
// → task → result. Proves: server boots (registry ON by default, graceful
// fallback for the empty registry), a flat agent is created, a session resolves,
// and a REAL model runs end-to-end. Throwaway DB so the real store is untouched.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = "/Users/nix/dev/node/adhd-agent-registry/dist/packages/ai/agent-mcp/src/index.js";
const text = (r) => (r?.content?.[0]?.text ?? JSON.stringify(r));
const j = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, DATABASE_PATH: "/tmp/livetest-mcp.db", SSE_PORT: "3099" },
  stderr: "pipe",
});
const client = new Client({ name: "live-test", version: "1.0.0" }, { capabilities: {} });

const out = {};
try {
  await client.connect(transport);
  out.connected = true;

  const tools = await client.listTools();
  out.tool_count = tools.tools.length;
  out.has_runtime = ["agent", "task", "result"].every((n) => tools.tools.some((t) => t.name === n));

  // 1. create a flat-systemPrompt agent on a REAL claudecli provider
  const created = await client.callTool({ name: "agent_create", arguments: {
    name: "livetest-assistant",
    provider: { type: "claudecli", model: "sonnet", claudePath: "/Users/nix/.local/bin/claude", timeoutMs: 120000 },
    systemPrompt: "You are a terse assistant. Reply with ONLY the answer, no preamble.",
    mcpServers: {}, permissions: {},
  }});
  out.agent_create = j(created);

  // 2. open a session (this is where the prompt-resolver runs: registry ON → empty → graceful fallback to the flat prompt)
  const sess = await client.callTool({ name: "agent", arguments: { name: "livetest-assistant" } });
  const session_id = j(sess).session_id;
  out.session_id = session_id;

  // 3. run a real task through the real model
  const t0 = Date.now();
  const taskRes = await client.callTool({ name: "task", arguments: {
    session_id, prompt: "What is 17 + 25? Reply with only the number.", background: false,
  }});
  out.elapsed_ms = Date.now() - t0;
  out.task = j(taskRes);
} catch (e) {
  out.ERROR = String(e?.stack || e);
} finally {
  try { await client.close(); } catch {}
}
console.log("LIVE_TEST_RESULT " + JSON.stringify(out, null, 2));
process.exit(out.ERROR ? 1 : 0);
