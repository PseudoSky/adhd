import { describe, expect, it, vi } from "vitest";
import {
    contextWindowFor,
    decideCompaction,
    compactMessages,
    groupIntoAtomicUnits,
    DEFAULT_COMPACTION_TRIGGER_FRACTION,
} from "../engine/context-window.js";
import type { Message } from "../validation/index.js";

let seq = 0;
const base = () => ({
    id: `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`,
    sessionId: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-11T00:00:00.000Z",
});
const system = (c: string): Message => ({ ...base(), role: "system", content: c });
const user = (c: string): Message => ({ ...base(), role: "user", content: c });
const assistant = (c: string): Message => ({ ...base(), role: "assistant", content: c });
const assistantCalling = (id: string): Message => ({
    ...base(), role: "assistant", content: "",
    toolCalls: [{ id, server: "fs", tool: "read", arguments: { p: "/x" } }],
});
const toolReply = (id: string, result: unknown): Message => ({
    ...base(), role: "tool", toolResults: [{ toolCallId: id, result, isError: false }],
});

function assertNoOrphans(messages: Message[]): void {
    messages.forEach((m, i) => {
        if (m.role !== "tool") return;
        let j = i - 1;
        while (j >= 0 && messages[j].role === "tool") j--;
        const opener = messages[j];
        expect(opener?.role === "assistant" && (opener.toolCalls?.length ?? 0) > 0).toBe(true);
    });
}

describe("contextWindowFor", () => {
    it("returns the true window per model family (longest-prefix wins)", () => {
        expect(contextWindowFor("deepseek-v4-flash")).toBe(1_000_000);
        expect(contextWindowFor("deepseek-v4-pro")).toBe(1_000_000);
        expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
        expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
    });
    it("falls back to a safe small window for unknown models (never 'infinite')", () => {
        expect(contextWindowFor("some-unknown-model")).toBe(128_000);
        expect(contextWindowFor(undefined)).toBe(128_000);
    });
});

describe("decideCompaction", () => {
    it("triggers off the PROVIDER-reported context, not the local estimate", () => {
        // Tiny pending messages, but the provider reported a near-full context.
        const d = decideCompaction(800_000, [user("hi")], "deepseek-v4-flash");
        expect(d.window).toBe(1_000_000);
        expect(d.threshold).toBe(750_000);
        expect(d.shouldCompact).toBe(true);
    });
    it("does not trigger well under the threshold", () => {
        expect(decideCompaction(43_000, [], "deepseek-v4-flash").shouldCompact).toBe(false);
    });
    it("falls back to a local estimate before the first call (no reported context)", () => {
        const huge = user("x".repeat(4_000_000)); // ~1M tokens
        expect(decideCompaction(undefined, [huge], "deepseek-v4-flash").shouldCompact).toBe(true);
        expect(decideCompaction(undefined, [user("hi")], "deepseek-v4-flash").shouldCompact).toBe(false);
    });
    it("uses the default trigger fraction", () => {
        expect(DEFAULT_COMPACTION_TRIGGER_FRACTION).toBe(0.75);
    });
});

describe("compactMessages", () => {
    it("preserves the system head and the recent tail, folding the middle into one summary", async () => {
        const messages: Message[] = [
            system("SYS"),
            user("turn 1"), assistant("a1"),
            user("turn 2"), assistant("a2"),
            user("turn 3"), assistant("a3"),
            user("turn 4"), assistant("a4"),
            user("turn 5"), assistant("a5"),
        ];
        const summarise = vi.fn(async () => "SUMMARY");

        const out = await compactMessages(messages, summarise, { keepRecentUnits: 4 });

        expect(out[0]).toBe(messages[0]);                     // system head preserved verbatim
        expect(out[1].role).toBe("user");
        expect(out[1].content).toContain("SUMMARY");          // one synthetic summary message
        // Tail (last 4 units) preserved verbatim.
        expect(out.slice(2).map(m => m.content)).toEqual(["turn 4", "a4", "turn 5", "a5"]);
        expect(summarise).toHaveBeenCalledOnce();
    });

    it("never splits an assistant from its tool replies when choosing the tail", async () => {
        const messages: Message[] = [
            system("SYS"),
            user("q1"),
            assistantCalling("c1"), toolReply("c1", { a: 1 }),
            assistantCalling("c2"), toolReply("c2", { b: 2 }),
            assistantCalling("c3"), toolReply("c3", { c: 3 }),
            user("q2"),
        ];
        const out = await compactMessages(messages, async () => "S", { keepRecentUnits: 2, minUnitsToCompact: 1 });
        assertNoOrphans(out);
    });

    it("leaves history UNCHANGED if the summariser throws (best-effort, never drops history)", async () => {
        const messages: Message[] = [
            system("SYS"), user("a"), assistant("b"), user("c"), assistant("d"),
            user("e"), assistant("f"), user("g"), assistant("h"),
        ];
        const out = await compactMessages(messages, async () => { throw new Error("summary failed"); }, {
            keepRecentUnits: 2,
        });
        expect(out).toEqual(messages);
    });

    it("does nothing when there is not enough middle to compact", async () => {
        const messages: Message[] = [system("SYS"), user("a"), assistant("b")];
        const summarise = vi.fn(async () => "S");
        const out = await compactMessages(messages, summarise, { keepRecentUnits: 4, minUnitsToCompact: 2 });
        expect(out).toEqual(messages);
        expect(summarise).not.toHaveBeenCalled();
    });

    it("shrinks the message count (so the caller can detect a real compaction happened)", async () => {
        const messages: Message[] = [
            system("SYS"),
            ...Array.from({ length: 20 }, (_, i) => user(`turn ${i}`)),
        ];
        const out = await compactMessages(messages, async () => "S", { keepRecentUnits: 4 });
        expect(out.length).toBeLessThan(messages.length);
        // head + summary + 4 tail = 6
        expect(out.length).toBe(6);
    });
});

describe("groupIntoAtomicUnits (shared with windowing)", () => {
    it("binds parallel tool replies to their single assistant", () => {
        const msgs: Message[] = [
            assistantCalling("c1"),
            toolReply("c1", {}), toolReply("c1", {}),
            user("next"),
        ];
        // NB: these are separate tool ids in reality; here the point is the grouping shape.
        const units = groupIntoAtomicUnits(msgs);
        expect(units[0].length).toBe(3);   // assistant + its 2 tool replies
        expect(units[1].length).toBe(1);   // the user turn
    });
});
