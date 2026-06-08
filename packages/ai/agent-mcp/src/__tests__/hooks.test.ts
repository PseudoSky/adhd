import { describe, expect, it, vi } from "vitest";
import { HookRegistry } from "../engine/hooks.js";

describe("HookRegistry", () => {
    it("calls a registered handler with the emitted payload", async () => {
        const registry = new HookRegistry();
        const handler = vi.fn();

        registry.register("task:cancelled", handler);
        await registry.emit("task:cancelled", {
            executionContext: {
                taskId: "t-1",
                sessionId: "s-1",
                agentName: "agent",
                agentDefinition: {
                    name: "agent",
                    version: 1,
                    provider: { type: "openai", model: "gpt-4o-mini" },
                    systemPrompt: "",
                    mcpServers: {},
                    permissions: {},
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                recursionDepth: 0,
                toolCallCount: 0,
            },
        });

        expect(handler).toHaveBeenCalledOnce();
    });

    it("is a no-op when no handlers are registered for the event", async () => {
        const registry = new HookRegistry();
        // Should not throw
        await expect(
            registry.emit("task:cancelled", {
                executionContext: {
                    taskId: "t-1",
                    sessionId: "s-1",
                    agentName: "agent",
                    agentDefinition: {
                        name: "agent",
                        version: 1,
                        provider: { type: "openai", model: "gpt-4o-mini" },
                        systemPrompt: "",
                        mcpServers: {},
                        permissions: {},
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                    recursionDepth: 0,
                    toolCallCount: 0,
                },
            })
        ).resolves.toBeUndefined();
    });

    it("awaits async handlers before returning", async () => {
        const registry = new HookRegistry();
        const order: number[] = [];

        registry.register("session:created", async () => {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
            order.push(1);
        });

        const session = {
            id: "s-1",
            agentName: "agent",
            agentVersion: 1,
            status: "active" as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        await registry.emit("session:created", { session });
        order.push(2);

        expect(order).toEqual([1, 2]);
    });

    it("calls multiple handlers for the same event in registration order", async () => {
        const registry = new HookRegistry();
        const calls: number[] = [];

        registry.register("session:created", () => { calls.push(1); });
        registry.register("session:created", () => { calls.push(2); });
        registry.register("session:created", () => { calls.push(3); });

        const session = {
            id: "s-1",
            agentName: "agent",
            agentVersion: 1,
            status: "active" as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        await registry.emit("session:created", { session });
        expect(calls).toEqual([1, 2, 3]);
    });

    it("swallows handler errors and continues to the next handler", async () => {
        const registry = new HookRegistry();
        const secondHandler = vi.fn();

        registry.register("session:created", () => {
            throw new Error("handler failure");
        });
        registry.register("session:created", secondHandler);

        const session = {
            id: "s-1",
            agentName: "agent",
            agentVersion: 1,
            status: "active" as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        await registry.emit("session:created", { session });
        expect(secondHandler).toHaveBeenCalledOnce();
    });

    it("swallowed error does not throw from emit()", async () => {
        const registry = new HookRegistry();

        registry.register("session:created", () => {
            throw new Error("fatal plugin error");
        });

        const session = {
            id: "s-1",
            agentName: "agent",
            agentVersion: 1,
            status: "active" as const,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        await expect(
            registry.emit("session:created", { session })
        ).resolves.toBeUndefined();
    });
});
