/**
 * ScriptedProvider — deterministic LLM provider for integration tests.
 *
 * Implements the real LLMProvider interface.
 * Returns programmable responses per chat() call in sequence.
 * After all scripted turns are exhausted, defaults to a "completed" response.
 *
 * Supported turn types:
 *  - "completed"    → returns stopReason "completed" with given content
 *  - "tool_calls"   → returns stopReason "tool_calls" with given tool calls
 *  - "hitl"         → returns a single request_human_input tool call
 *
 * Supports a beforeCall hook so tool stubs can coordinate with Latches.
 */

import type { LLMProvider, ProviderChatResponse } from "../../providers/types.js";
import type { Message } from "../../validation/index.js";
import { generateId } from "../../utils/ids.js";
import { nowIso } from "../../utils/timestamps.js";

export interface ToolCallSpec {
    server: string;
    tool: string;
    arguments: unknown;
    /** Override the generated call ID */
    id?: string;
}

export type ScriptedTurn =
    | { type: "completed"; content: string }
    | { type: "tool_calls"; toolCalls: ToolCallSpec[] }
    | { type: "hitl"; prompt: string };

export class ScriptedProvider implements LLMProvider {
    private readonly turns: ScriptedTurn[];
    private callIndex = 0;

    /**
     * Optional hook invoked at the START of each chat() call (before returning).
     * Receives the call index (0-based) so tests can key on specific turns.
     */
    beforeCall?: (callIndex: number) => Promise<void>;

    constructor(turns: ScriptedTurn[]) {
        this.turns = turns;
    }

    async chat(): Promise<ProviderChatResponse> {
        const idx = this.callIndex++;

        if (this.beforeCall) {
            await this.beforeCall(idx);
        }

        const turn = this.turns[idx] ?? { type: "completed", content: "done" };

        const sessionId = generateId();

        if (turn.type === "completed") {
            const msg: Message = {
                id: generateId(),
                sessionId,
                role: "assistant",
                content: turn.content,
                createdAt: nowIso(),
            };
            return { message: msg, stopReason: "completed" };
        }

        if (turn.type === "hitl") {
            const callId = generateId();
            const msg: Message = {
                id: generateId(),
                sessionId,
                role: "assistant",
                content: undefined,
                toolCalls: [
                    {
                        id: callId,
                        server: "builtin",
                        tool: "request_human_input",
                        arguments: { prompt: turn.prompt },
                    },
                ],
                createdAt: nowIso(),
            };
            return { message: msg, stopReason: "tool_calls" };
        }

        // type === "tool_calls"
        const calls = turn.toolCalls.map((spec) => ({
            id: spec.id ?? generateId(),
            server: spec.server,
            tool: spec.tool,
            arguments: spec.arguments,
        }));

        const msg: Message = {
            id: generateId(),
            sessionId,
            role: "assistant",
            content: undefined,
            toolCalls: calls,
            createdAt: nowIso(),
        };

        return { message: msg, stopReason: "tool_calls" };
    }
}
