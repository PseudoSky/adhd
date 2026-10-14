/**
 * R10 S2 AC4: the same-turn concurrency classification table (pure).
 *
 * guards: classifyTool, schedulingClassOf or assignGroups mislabel a tool, so a write runs as a safe read (or a read is serialised) and a delegation call is ordered or gates others.
 * tier: S
 * cites: R10 S2 AC4 (classification table) and the AC6 grouping cases.
 */
import { describe, expect, it } from "vitest";

import {
    DELEGATION_TOOL_NAMES,
    assignGroups,
    classifyTool,
    isDelegationTool,
    schedulingClassOf,
    splitQualifiedToolName,
    type ToolSchedulingClass,
} from "../engine/tool-class.js";
import type { ToolDefinition } from "../providers/types.js";

const def = (name: string, annotations?: ToolDefinition["annotations"]): ToolDefinition => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    ...(annotations ? { annotations } : {}),
});

describe("R10 S2 AC4: classifyTool table", () => {
    const table: Array<[string, string, ToolDefinition["annotations"] | undefined, "safe" | "barrier"]> = [
        // builtin shell: a barrier whatever it advertises
        ["shell argv executor", "shell__shell_execute", undefined, "barrier"],
        ["shell argv executor even if it claims read-only", "shell__shell_execute", { readOnlyHint: true }, "barrier"],
        // fs: by the server's hint
        ["fs read (readOnlyHint true)", "fs__read_text_file", { readOnlyHint: true }, "safe"],
        ["fs edit (readOnlyHint false)", "fs__edit_file", { readOnlyHint: false, destructiveHint: true }, "barrier"],
        ["fs write (readOnlyHint false)", "fs__write_file", { readOnlyHint: false, idempotentHint: true }, "barrier"],
        ["fs create_directory (readOnlyHint false)", "fs__create_directory", { readOnlyHint: false }, "barrier"],
        // absent annotation
        ["fs tool with no annotation: conservative barrier", "fs__new_tool", undefined, "barrier"],
        ["fs tool with annotations but no readOnlyHint", "fs__odd", { destructiveHint: false }, "barrier"],
        ["third-party tool with no annotation: today's behaviour (safe)", "notes__append", undefined, "safe"],
        ["third-party tool with annotations but no readOnlyHint", "notes__append", { idempotentHint: true }, "safe"],
        ["third-party read", "notes__search", { readOnlyHint: true }, "safe"],
        ["third-party write that advertises it", "notes__append", { readOnlyHint: false }, "barrier"],
        // agent-mcp: delegation and control tools never ordered by class (safe)
        ["agent-mcp agent", "agent-mcp__agent", undefined, "safe"],
        ["agent-mcp task", "agent-mcp__task", undefined, "safe"],
        ["agent-mcp tasks_batch", "agent-mcp__tasks_batch", undefined, "safe"],
        ["agent-mcp result", "agent-mcp__result", undefined, "safe"],
        ["agent-mcp task_cancel", "agent-mcp__task_cancel", undefined, "safe"],
        ["agent-mcp task_resume", "agent-mcp__task_resume", undefined, "safe"],
        // agent-mcp admin tools mutate shared stores: barrier unless advertised read-only
        ["agent-mcp session_clear", "agent-mcp__session_clear", undefined, "barrier"],
        ["agent-mcp session_update", "agent-mcp__session_update", undefined, "barrier"],
        ["agent-mcp pricing_refresh", "agent-mcp__pricing_refresh", undefined, "barrier"],
        ["agent-mcp usage_query (no hint)", "agent-mcp__usage_query", undefined, "barrier"],
        ["agent-mcp guide advertised read-only", "agent-mcp__guide", { readOnlyHint: true }, "safe"],
        ["agent-mcp task_list advertised read-only", "agent-mcp__task_list", { readOnlyHint: true }, "safe"],
        // a delegation-looking name on another server is NOT a delegation tool
        ["foreign server's task tool", "other__task", undefined, "safe"],
        ["foreign server's task tool that writes", "other__task", { readOnlyHint: false }, "barrier"],
        // an unprefixed name is its own server
        ["bare name", "lonely", undefined, "safe"],
    ];
    for (const [label, name, annotations, expected] of table) {
        it(`R10 S2 AC4: ${label} -> ${expected}`, () => {
            expect(classifyTool(name, def(name, annotations))).toBe(expected);
        });
    }

    it("R10 S2 AC4: the definition is optional (name rules still apply)", () => {
        expect(classifyTool("shell__shell_execute")).toBe("barrier");
        expect(classifyTool("agent-mcp__task")).toBe("safe");
        expect(classifyTool("fs__edit_file")).toBe("barrier");
        expect(classifyTool("somewhere__thing")).toBe("safe");
    });

    it("R10 S2 AC4: only agent-mcp delegation tools are delegation tools", () => {
        expect([...DELEGATION_TOOL_NAMES].sort()).toEqual(["agent", "result", "task", "task_cancel", "task_resume", "tasks_batch"]);
        for (const t of DELEGATION_TOOL_NAMES) {
            expect(isDelegationTool(`agent-mcp__${t}`)).toBe(true);
            expect(isDelegationTool(`other__${t}`)).toBe(false);
        }
        expect(isDelegationTool("agent-mcp__session_clear")).toBe(false);
    });

    it("R10 S2 AC4: schedulingClassOf maps delegation to unordered and defers everything else to the class function", () => {
        expect(schedulingClassOf("agent-mcp__tasks_batch")).toBe("unordered");
        expect(schedulingClassOf("fs__edit_file")).toBe("barrier");
        expect(schedulingClassOf("fs__read_text_file", def("fs__read_text_file", { readOnlyHint: true }))).toBe("safe");
        expect(schedulingClassOf("x__y", undefined, () => "barrier")).toBe("barrier");
        expect(schedulingClassOf("agent-mcp__task", undefined, () => "barrier")).toBe("unordered");
    });

    it("R10 S2 AC4: splitQualifiedToolName splits at the first separator", () => {
        expect(splitQualifiedToolName("fs__read_text_file")).toEqual({ server: "fs", tool: "read_text_file" });
        expect(splitQualifiedToolName("a__b__c")).toEqual({ server: "a", tool: "b__c" });
        expect(splitQualifiedToolName("bare")).toEqual({ server: "bare", tool: "bare" });
    });
});

describe("R10 S2 AC6 (grouping): assignGroups", () => {
    const g = (classes: ToolSchedulingClass[]) => assignGroups(classes);
    it("a contiguous run of safe calls shares a group; every barrier is its own", () => {
        expect(g(["safe", "safe", "barrier", "safe", "safe", "barrier", "barrier"])).toEqual([0, 0, 1, 2, 2, 3, 4]);
    });
    it("a leading barrier is group 0", () => {
        expect(g(["barrier", "safe"])).toEqual([0, 1]);
    });
    it("an unordered call takes the group of the nearest ordered call before it (0 when none)", () => {
        expect(g(["unordered", "safe", "unordered", "barrier", "unordered", "safe"])).toEqual([0, 0, 0, 1, 1, 2]);
        expect(g(["unordered", "unordered"])).toEqual([0, 0]);
    });
    it("empty in, empty out", () => {
        expect(g([])).toEqual([]);
    });
});
