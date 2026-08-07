import type {
  IMcpToolClient,
  McpCallToolResult,
} from '../../lib/agent-runner.js';

export interface RecordedCall {
  name: string;
  arguments: Record<string, unknown> | undefined;
}

/** Sentinel returned by a `FakeToolHandler` to simulate an agent-mcp `isError: true` response. */
export interface FakeMcpError {
  __mcpError: { code: string; message: string };
}

export function mcpError(code: string, message: string): FakeMcpError {
  return { __mcpError: { code, message } };
}

function isFakeError(value: unknown): value is FakeMcpError {
  return (
    !!value &&
    typeof value === 'object' &&
    '__mcpError' in (value as Record<string, unknown>)
  );
}

export type FakeToolHandler = (
  args: Record<string, unknown> | undefined
) => unknown;

/**
 * Configurable fake `IMcpToolClient` for `AgentMcpRunner` tests.
 *
 * Encodes responses exactly the way the real `@modelcontextprotocol/sdk`
 * `Client` does over stdio — JSON-stringified text content for success,
 * `isError: true` + a `[CODE] message` text block for failure (mirroring
 * agent-mcp's `toMcpContent`/`toMcpErrorContent`, packages/ai/agent-mcp/src/server.ts)
 * — so `AgentMcpRunner`'s own wire-parsing logic is exercised for real
 * rather than bypassed. This is the injected fake referenced by
 * AgentMcpRunnerConfig.clientFactory; it never spawns a subprocess. The
 * real-seam live proof (a real agent-mcp process) is owned by the
 * tests-real-e2e milestone, not this one.
 */
export class FakeMcpToolClient implements IMcpToolClient {
  readonly calls: RecordedCall[] = [];
  connectCallCount = 0;
  closeCallCount = 0;

  constructor(private readonly handlers: Record<string, FakeToolHandler>) {}

  async connect(): Promise<void> {
    this.connectCallCount++;
  }

  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult> {
    this.calls.push({ name: params.name, arguments: params.arguments });

    const handler = this.handlers[params.name];
    if (!handler) {
      throw new Error(
        `FakeMcpToolClient: no handler registered for tool '${params.name}'`
      );
    }

    const outcome = handler(params.arguments);

    if (isFakeError(outcome)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `[${outcome.__mcpError.code}] ${outcome.__mcpError.message}`,
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
    };
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }
}
