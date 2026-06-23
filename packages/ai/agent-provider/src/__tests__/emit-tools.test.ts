/**
 * Tests for FEAT-007 runtime tool emitter (emit-tools.ts).
 *
 * Drives the REAL emitter and asserts the consumer-visible output — the emitted
 * tool shape — not implementation internals. Assertions have teeth: a wrong shape
 * or missing gate makes these tests red.
 *
 * Negative-control (runtime-tool-forwarding.4): if the server_side branch were
 * deleted so web_search fell through to the custom branch, the first test would
 * fail because the emitted entry would have `input_schema` and lack `type`.
 *
 * Coverage:
 *   [runtime-tool-forwarding.1] — server-side → type-tagged entry with NO input_schema
 *   [runtime-tool-forwarding.2] — unsupported → throw UnsupportedNativeToolError
 *   [runtime-tool-forwarding.3] — both paths tested via the real emitter
 *   [runtime-tool-forwarding.4] — negative-control: wrong shape / missing throw makes test red
 */

import { describe, expect, it } from "vitest";

import {
    emitTool,
    emitToolsForProvider,
    UnsupportedNativeToolError,
    type EmittedServerSideTool,
    type EmittedCustomTool,
    type ToolFormatLookup,
} from "../runtime/emit-tools.js";
import type { ToolFormat } from "../store/tool-format-store.js";

// ──────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────

/** Minimal ToolDefinition for testing. */
const webSearchTool = {
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
} as const;

const bashTool = {
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
} as const;

const customTool = {
    name: "my_custom_tool",
    description: "A user-defined function",
    inputSchema: { type: "object", properties: { input: { type: "string" } } },
} as const;

/** In-memory lookup fixture — simulates ToolFormatStore.getShape. */
function makeLookup(
    rows: Record<string, ToolFormat>
): ToolFormatLookup {
    return (providerId, canonicalTool) =>
        rows[`${providerId}:${canonicalTool}`] ?? null;
}

/** Pre-built lookup with the three canonical anthropic rows. */
const anthropicLookup = makeLookup({
    "anthropic:web_search": {
        providerId: "anthropic",
        canonicalTool: "web_search",
        emitShape: "server_side",
        typeTag: "web_search_20250305",
        note: null,
    },
    "anthropic:bash": {
        providerId: "anthropic",
        canonicalTool: "bash",
        emitShape: "unsupported",
        typeTag: null,
        note: "Anthropic `bash` is client-executed and requires a local execution loop, which @adhd/agent-provider does not yet implement",
    },
    // my_custom_tool intentionally NOT registered → falls through to "custom"
});

// ──────────────────────────────────────────────
// [runtime-tool-forwarding.1]
// server-side → type-tagged entry; NO input_schema
// ([inv:server-side-shape], [def:server-side-tool])
// ──────────────────────────────────────────────

describe("emitTool — server-side tool (FEAT-007 server-side branch)", () => {
    it("emits a type-tagged entry for an Anthropic web_search server-side tool", () => {
        const emitted = emitTool(webSearchTool, "anthropic", anthropicLookup);

        // Must have a `type` field matching web_search_* ([def:server-side-tool])
        expect("type" in emitted).toBe(true);
        expect((emitted as EmittedServerSideTool).type).toMatch(/^web_search/);
        expect((emitted as EmittedServerSideTool).type).toBe("web_search_20250305");

        // Must have the canonical tool name
        expect(emitted.name).toBe("web_search");

        // Must NOT have input_schema ([inv:server-side-shape])
        // Negative-control: if the server_side branch is removed this assertion fails
        expect("input_schema" in emitted).toBe(false);

        // Must NOT be a custom def shape
        expect("description" in emitted).toBe(false);
    });

    it("emitted server-side entry has no description field (mutually exclusive with custom)", () => {
        const emitted = emitTool(webSearchTool, "anthropic", anthropicLookup) as EmittedServerSideTool;

        // A type-tagged server-side entry carries only type + name
        expect(Object.keys(emitted).sort()).toEqual(["name", "type"].sort());
    });
});

// ──────────────────────────────────────────────
// [runtime-tool-forwarding.2]
// unsupported → throw, never return undefined / skip
// ([inv:gate-not-noop], [def:unsupported-native])
// ──────────────────────────────────────────────

describe("emitTool — unsupported native tool (FEAT-007 gated error)", () => {
    it("throws UnsupportedNativeToolError for an Anthropic bash (client-exec) tool", () => {
        expect(() => emitTool(bashTool, "anthropic", anthropicLookup)).toThrow(
            UnsupportedNativeToolError
        );
    });

    it("thrown error message contains the tool name AND the provider id", () => {
        let caught: unknown;
        try {
            emitTool(bashTool, "anthropic", anthropicLookup);
        } catch (e) {
            caught = e;
        }

        expect(caught).toBeInstanceOf(UnsupportedNativeToolError);
        const err = caught as UnsupportedNativeToolError;

        // Message must name both tool + provider ([inv:gate-not-noop])
        expect(err.message).toContain("bash");
        expect(err.message).toContain("anthropic");

        // Typed fields available to callers
        expect(err.toolName).toBe("bash");
        expect(err.providerId).toBe("anthropic");
        expect(err.code).toBe("UNSUPPORTED_NATIVE_TOOL");
    });

    it("thrown error message includes the registered note (actionable context)", () => {
        let caught: unknown;
        try {
            emitTool(bashTool, "anthropic", anthropicLookup);
        } catch (e) {
            caught = e;
        }

        const err = caught as UnsupportedNativeToolError;
        // The note from the format row must be surfaced in the message
        expect(err.message).toContain("local execution loop");
    });

    it("never returns undefined or skips — the emitter must throw, not no-op", () => {
        // Proves [inv:gate-not-noop]: the function must throw, not silently return
        let didThrow = false;
        try {
            emitTool(bashTool, "anthropic", anthropicLookup);
        } catch {
            didThrow = true;
        }
        expect(didThrow).toBe(true);
    });
});

// ──────────────────────────────────────────────
// custom tool (no registered format row → plain function def)
// ──────────────────────────────────────────────

describe("emitTool — custom tool (no registered row → standard def)", () => {
    it("emits the standard {name, description, input_schema} shape for an unregistered tool", () => {
        // my_custom_tool has no format row → custom shape by default
        const emitted = emitTool(customTool, "anthropic", anthropicLookup) as EmittedCustomTool;

        expect(emitted.name).toBe("my_custom_tool");
        expect(emitted.description).toBe("A user-defined function");
        expect(emitted.input_schema).toEqual(customTool.inputSchema);

        // Must NOT have a type field (that would be the server-side shape)
        expect("type" in emitted).toBe(false);
    });

    it("emits custom shape even when the tool is registered as 'custom' emit_shape", () => {
        const customLookup = makeLookup({
            "openai:my_tool": {
                providerId: "openai",
                canonicalTool: "my_tool",
                emitShape: "custom",
                typeTag: null,
                note: null,
            },
        });

        const tool = {
            name: "my_tool",
            description: "An openai custom tool",
            inputSchema: { type: "object" },
        };

        const emitted = emitTool(tool, "openai", customLookup) as EmittedCustomTool;
        expect(emitted.name).toBe("my_tool");
        expect(emitted.description).toBe("An openai custom tool");
        expect(emitted.input_schema).toEqual({ type: "object" });
        expect("type" in emitted).toBe(false);
    });
});

// ──────────────────────────────────────────────
// emitToolsForProvider — batch behavior
// ──────────────────────────────────────────────

describe("emitToolsForProvider — batch emitter", () => {
    it("emits a mixed list with one server-side and one custom tool", () => {
        const tools = [webSearchTool, customTool];
        const emitted = emitToolsForProvider(tools, "anthropic", anthropicLookup);

        expect(emitted).toHaveLength(2);

        // First: server-side web_search
        const first = emitted[0] as EmittedServerSideTool;
        expect(first.type).toBe("web_search_20250305");
        expect("input_schema" in first).toBe(false);

        // Second: custom tool with full def
        const second = emitted[1] as EmittedCustomTool;
        expect(second.name).toBe("my_custom_tool");
        expect(second.input_schema).toEqual(customTool.inputSchema);
    });

    it("throws on the first unsupported tool in a batch — fails fast, not silently", () => {
        // Batch includes bash (unsupported) → must throw, not return a partial list
        expect(() =>
            emitToolsForProvider([webSearchTool, bashTool], "anthropic", anthropicLookup)
        ).toThrow(UnsupportedNativeToolError);
    });

    it("returns an empty array for an empty tool list", () => {
        expect(emitToolsForProvider([], "anthropic", anthropicLookup)).toEqual([]);
    });
});

// ──────────────────────────────────────────────
// [runtime-tool-forwarding.4] Negative-control
// Proves teeth: a wrong custom shape for web_search makes these assertions red.
// ──────────────────────────────────────────────

describe("negative-control — server-side branch cannot be replaced by custom", () => {
    it("a lookup that returns null (custom fallback) for web_search produces a DIFFERENT shape — no type field", () => {
        // Simulates the broken state where the server-side branch is absent and
        // web_search falls through to the custom path.
        const noFormatLookup: ToolFormatLookup = () => null;
        const emitted = emitTool(webSearchTool, "anthropic", noFormatLookup) as EmittedCustomTool;

        // With no format row the emitter falls back to custom → has input_schema, no type
        expect("input_schema" in emitted).toBe(true);
        expect("type" in emitted).toBe(false);

        // This test proves that the REAL server_side path (above) behaves differently.
        // If someone removes the server_side branch, the first test suite goes red
        // because "type" would be absent and "input_schema" would be present.
    });
});
