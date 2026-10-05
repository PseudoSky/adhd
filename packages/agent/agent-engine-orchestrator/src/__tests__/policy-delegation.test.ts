import { describe, expect, it } from "vitest";
import {
  Orchestrator,
  type OrchestratorTaskStore,
  type OrchestratorSessionStore,
} from "../engine/orchestrator.js";
import { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";

/**
 * Backlog 4e829a08 — PROOF that PolicyEngine enforcement (recursion depth,
 * tool-loop, delegation allowlist) actually survives a REAL delegation CHAIN,
 * not just a single in-request check.
 *
 * The chain is driven by REAL components: the real `Orchestrator`, the real
 * `PolicyEngine`, and a registry whose `agent-mcp__agent` client recursively
 * runs the next hop through the SAME orchestrator + SAME policy — exactly how
 * agent-mcp executes a delegation today. Only the LLM provider boundary is
 * scripted (no paid model), which is the one legitimate boundary to mock.
 *
 * Each assertion goes RED if the corresponding PolicyEngine check is removed.
 */

const AGENT_TOOL = "agent-mcp__agent";
const MAX_TOOL_LOOPS = 50;

function makeAgentDefinition(maxToolLoops?: number) {
  return {
    name: "policy-chain-agent",
    version: 1,
    provider: { type: "anthropic" as const, model: "claude-haiku-4-5" },
    systemPrompt: "delegating agent",
    mcpServers: {},
    permissions: {},
    ...(maxToolLoops !== undefined ? { maxToolLoops } : {}),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

const taskStore: OrchestratorTaskStore = {
  updateStatus: () => undefined,
  appendEvent: () => undefined,
  unregisterCancellation: () => undefined,
};
const sessionStore: OrchestratorSessionStore = {
  appendMessage: async () => undefined,
  close: () => undefined,
};

/**
 * Provider that, while `depth < stopDepth`, emits ONE delegation tool call to
 * `child`, carrying its own depth so the registry can spawn the next hop.
 * At/after `stopDepth` it completes — so the chain is finite and only policy
 * (not an endless loop) can stop it early.
 */
function delegatingProvider(stopDepth: number): LLMProvider {
  return {
    chat: async ({ messages }: { messages: Message[] }): Promise<ProviderChatResponse> => {
      // Depth lives in the FIRST message (the run's original user turn); scan all
      // messages because later turns append tool-result messages.
      const depth = Number(
        messages
          .map((m) => m.content ?? "")
          .map((c) => /__depth=(\d+)/.exec(c)?.[1])
          .find((d) => d !== undefined) ?? "-1"
      );
      const hasToolResult = messages.some((m) => m.role === "tool");
      const id = generateId();
      // Delegate exactly ONCE per hop (before any tool result); then complete.
      if (depth >= stopDepth || hasToolResult) {
        return {
          message: {
            id,
            sessionId: "",
            role: "assistant",
            content: `completed at depth ${depth}`,
            createdAt: nowIso(),
          },
          stopReason: "completed",
        };
      }
      return {
        message: {
          id,
          sessionId: "",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: generateId(),
              server: "agent-mcp",
              tool: "agent",
              arguments: { name: "child", _depth: depth },
            },
          ],
          createdAt: nowIso(),
        },
        stopReason: "tool_calls",
      };
    },
  };
}

/**
 * Registry whose `agent-mcp__agent` client recursively runs the next hop
 * (`_depth + 1`) through the same runner. A fresh taskId per hop mirrors
 * agent-mcp; `closeAll` is a no-op so a child's teardown cannot tear down the
 * parent's shared registry.
 */
function makeDelegatingRegistry(
  policy: PolicyEngine,
  provider: LLMProvider,
  maxHops: number
): McpClientRegistry {
  const runAt = async (depth: number): Promise<string> => {
    const ctx: ExecutionContext = {
      taskId: generateId(),
      sessionId: generateId(),
      agentName: "policy-chain-agent",
      agentDefinition: makeAgentDefinition() as unknown as ExecutionContext["agentDefinition"],
      recursionDepth: depth,
      toolCallCount: 0,
    };
    const result = await new Orchestrator().run({
      executionContext: ctx,
      messages: [
        {
          id: generateId(),
          sessionId: ctx.sessionId,
          role: "user",
          content: `__depth=${depth}`,
          createdAt: nowIso(),
        },
      ],
      registry,
      provider,
      policy,
      taskStore,
      sessionStore,
      signal: new AbortController().signal,
      taskId: ctx.taskId,
    });
    return result.result;
  };

  const registry: McpClientRegistry = {
    listAllTools: async () => [
      {
        name: AGENT_TOOL,
        description: "",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    getClient: async () => ({
      callTool: async (_tool: string, args: Record<string, unknown>) => {
        const depth = Number(args["_depth"] ?? 0);
        if (depth + 1 > maxHops) {
          throw new Error("test harness: hop guard exceeded — chain did not terminate");
        }
        const result = await runAt(depth + 1);
        // agent-mcp returns a session_id for the delegated child.
        return { session_id: `sess-${depth + 1}`, result };
      },
    }),
    closeAll: async () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as McpClientRegistry;

  return registry;
}

describe("PolicyEngine survives a real delegation chain (4e829a08)", () => {
  it("stops a chain that exceeds serverMaxDepth with MAX_DEPTH_EXCEEDED", async () => {
    const policy = new PolicyEngine({
      serverMaxDepth: 2,
      serverMaxToolLoops: MAX_TOOL_LOOPS,
      serverAllowedAgents: ["child"],
    });
    const registry = makeDelegatingRegistry(policy, delegatingProvider(99), 99);

    await expect(
      new Orchestrator().run({
        executionContext: {
          taskId: generateId(),
          sessionId: generateId(),
          agentName: "policy-chain-agent",
          agentDefinition: makeAgentDefinition() as unknown as ExecutionContext["agentDefinition"],
          recursionDepth: 0,
          toolCallCount: 0,
        },
        messages: [
          {
            id: generateId(),
            sessionId: generateId(),
            role: "user",
            content: "__depth=0",
            createdAt: nowIso(),
          },
        ],
        registry,
        provider: delegatingProvider(99),
        policy,
        taskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId: generateId(),
      })
    ).rejects.toMatchObject({ code: "MAX_DEPTH_EXCEEDED" });
  });

  it("stops a chain targeting a disallowed agent with DELEGATION_NOT_ALLOWED", async () => {
    // Policy permits only 'child'; the provider delegates to 'forbidden'.
    const policy = new PolicyEngine({
      serverMaxDepth: 10,
      serverMaxToolLoops: MAX_TOOL_LOOPS,
      serverAllowedAgents: ["child"],
    });
    const forbiddenProvider: LLMProvider = {
      chat: async (): Promise<ProviderChatResponse> => ({
        message: {
          id: generateId(),
          sessionId: "",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: generateId(),
              server: "agent-mcp",
              tool: "agent",
              arguments: { name: "forbidden" },
            },
          ],
          createdAt: nowIso(),
        },
        stopReason: "tool_calls",
      }),
    };
    const registry = makeDelegatingRegistry(policy, forbiddenProvider, 10);

    await expect(
      new Orchestrator().run({
        executionContext: {
          taskId: generateId(),
          sessionId: generateId(),
          agentName: "policy-chain-agent",
          agentDefinition: makeAgentDefinition() as unknown as ExecutionContext["agentDefinition"],
          recursionDepth: 0,
          toolCallCount: 0,
        },
        messages: [
          {
            id: generateId(),
            sessionId: generateId(),
            role: "user",
            content: "delegate",
            createdAt: nowIso(),
          },
        ],
        registry,
        provider: forbiddenProvider,
        policy,
        taskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId: generateId(),
      })
    ).rejects.toMatchObject({ code: "DELEGATION_NOT_ALLOWED" });
  });

  it("NEGATIVE CONTROL: a higher depth limit lets the same chain complete", async () => {
    const policy = new PolicyEngine({
      serverMaxDepth: 5,
      serverMaxToolLoops: MAX_TOOL_LOOPS,
      serverAllowedAgents: ["child"],
    });
    const stopDepth = 3; // chain terminates on its own at depth 3, below the limit
    const registry = makeDelegatingRegistry(policy, delegatingProvider(stopDepth), 10);

    const result = await new Orchestrator().run({
      executionContext: {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "policy-chain-agent",
        agentDefinition: makeAgentDefinition() as unknown as ExecutionContext["agentDefinition"],
        recursionDepth: 0,
        toolCallCount: 0,
      },
      messages: [
        {
          id: generateId(),
          sessionId: generateId(),
          role: "user",
          content: "__depth=0",
          createdAt: nowIso(),
        },
      ],
      registry,
      provider: delegatingProvider(stopDepth),
      policy,
      taskStore,
      sessionStore,
      signal: new AbortController().signal,
      taskId: generateId(),
    });

    // The outermost run completes (its own turn, after the delegation returned).
    expect(result.result).toContain("completed at depth 0");
  });
});
