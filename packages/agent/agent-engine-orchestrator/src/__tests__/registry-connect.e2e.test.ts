/**
 * R10 S3 AC5 (stdio leg): the REAL stdio MCP client maps `tools/list` annotations onto
 * `ToolDefinition.annotations`. Lives in the e2e lane because the unit lane may not reference the
 * stdio transport classes (check-agent-lane-spawn.mjs, docs/decisions/0009-test-lanes-unit-vs-e2e.md).
 * No process is spawned here: the SDK client is replaced by a stub that answers `listTools`, which
 * is the exact seam the production client calls. The registry-level S3 AC1..AC3 / AC6 proofs
 * (concurrency, failure isolation, ordering, timings, toolClass) are in `registry-connect.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { StdioMcpClient } from "../clients/stdio-client.js";

const schema = { type: "object", properties: {} };

describe("R10 S3 AC5: stdio client annotation mapping", () => {
    it("R10 S3 AC5: the stdio client maps tools/list annotations onto ToolDefinition.annotations and leaves unannotated tools unchanged", async () => {
        const client = new StdioMcpClient("fs", { transport: "stdio", command: "noop" } as never);
        (client as unknown as { client: unknown }).client = {
            listTools: async () => ({
                tools: [
                    { name: "read", description: "r", inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: false } },
                    { name: "write", description: "w", inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
                    { name: "bare", description: "b", inputSchema: schema },
                ],
            }),
        };
        const listed = await client.listTools();
        expect(listed).toEqual([
            { name: "read", description: "r", inputSchema: schema, annotations: { readOnlyHint: true } },
            { name: "write", description: "w", inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } },
            { name: "bare", description: "b", inputSchema: schema },
        ]);
        expect("annotations" in listed[2]).toBe(false);
    });
});
