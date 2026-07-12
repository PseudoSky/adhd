import { describe, expect, it } from "vitest";
import { windowMessages } from "../engine/orchestrator.js";
import type { Message } from "../validation/index.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let seq = 0;
const base = () => ({
    id: `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`,
    sessionId: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-11T00:00:00.000Z",
});

const system = (content: string): Message => ({ ...base(), role: "system", content });
const user = (content: string): Message => ({ ...base(), role: "user", content });
const assistant = (content: string): Message => ({ ...base(), role: "assistant", content });

const assistantCalling = (callId: string, content = ""): Message => ({
    ...base(),
    role: "assistant",
    content,
    toolCalls: [{ id: callId, server: "filesystem", tool: "read_text_file", arguments: { path: "/x" } }],
});

const toolReply = (callId: string, result: unknown): Message => ({
    ...base(),
    role: "tool",
    toolResults: [{ toolCallId: callId, result, isError: false }],
});

/**
 * The wire-format invariant the provider enforces: every `tool` message must be
 * immediately preceded by the `assistant` message carrying the matching
 * `tool_calls`. Violating it is a hard 400 (BUG-ORCH-003).
 */
function assertNoOrphanedToolMessages(messages: Message[]): void {
    messages.forEach((message, i) => {
        if (message.role !== "tool") return;
        const callId = message.toolResults?.[0]?.toolCallId;
        const preceding = messages[i - 1];
        const openCallIds = new Set(
            (preceding?.role === "assistant" ? preceding.toolCalls ?? [] : []).map(tc => tc.id)
        );
        // The preceding message may also be an earlier tool reply in the same unit;
        // walk back to the assistant that opened the unit.
        let j = i - 1;
        while (j >= 0 && messages[j].role === "tool") j--;
        const opener = messages[j];
        const openerIds = new Set((opener?.toolCalls ?? []).map(tc => tc.id));

        expect(
            opener?.role === "assistant" && (openerIds.has(callId!) || openCallIds.has(callId!)),
            `orphaned tool message at index ${i} (tool_call_id=${callId}) — no preceding assistant with matching tool_calls`
        ).toBe(true);
    });
}

describe("windowMessages", () => {
    it("never orphans a tool message from the assistant that called it (BUG-ORCH-003)", () => {
        // The assistant's own content is what busts the budget. The old
        // implementation counted the tool reply as 0 tokens (payload lives in
        // toolResults, not content), kept it, then found the assistant too big
        // to fit and skipped it — orphaning the tool reply.
        const messages: Message[] = [
            system("sys"),
            user("older turn"),
            assistantCalling("call_1", "x".repeat(8_000)), // ~2000 tokens of content
            toolReply("call_1", { ok: true }),
            user("newest question"),
        ];

        const windowed = windowMessages(messages, 500);

        assertNoOrphanedToolMessages(windowed);
    });

    it("counts tool-result payloads toward the budget (BUG-ORCH-004)", () => {
        // A tool result carries its payload in toolResults, not content. If the
        // estimator only reads `content`, this 40k-char dump scores as 0 tokens
        // and is retained no matter the limit — the exact blindness that lets a
        // directory_tree dump blow the context.
        const hugeDump = { files: "y".repeat(40_000) }; // ~10_000 tokens

        const messages: Message[] = [
            system("sys"),
            assistantCalling("call_1"),
            toolReply("call_1", hugeDump),
            user("newest question"),
        ];

        const windowed = windowMessages(messages, 500);

        // The oversized assistant+tool unit must be dropped; only system + the
        // most-recent user turn survive.
        expect(windowed.map(m => m.role)).toEqual(["system", "user"]);
        expect(windowed.some(m => m.role === "tool")).toBe(false);
    });

    it("always preserves the system message at index 0", () => {
        const messages: Message[] = [
            system("sys"),
            user("a".repeat(40_000)),
            user("newest"),
        ];

        const windowed = windowMessages(messages, 100);

        expect(windowed[0]?.role).toBe("system");
        expect(windowed[0]?.content).toBe("sys");
    });

    it("always retains the most recent unit so the loop makes progress", () => {
        // Even when the newest turn alone exceeds the limit, it must survive —
        // otherwise the orchestrator would send an empty history and spin.
        const messages: Message[] = [
            system("sys"),
            user("old"),
            user("z".repeat(40_000)),
        ];

        const windowed = windowMessages(messages, 100);

        expect(windowed[windowed.length - 1]?.content).toBe("z".repeat(40_000));
    });

    it("drops contiguously from the oldest end — never punches holes in history", () => {
        // The old loop skipped an oversized message and then kept an OLDER,
        // smaller one, producing a non-contiguous history.
        const messages: Message[] = [
            system("sys"),
            user("oldest small"),          // small — old code would keep this...
            user("m".repeat(8_000)),       // ...after skipping this oversized one
            user("newest small"),
        ];

        const windowed = windowMessages(messages, 500);

        const kept = windowed.filter(m => m.role === "user").map(m => m.content);
        // Whatever survives must be a contiguous suffix of the original order.
        const original = ["oldest small", "m".repeat(8_000), "newest small"];
        const suffix = original.slice(original.length - kept.length);
        expect(kept).toEqual(suffix);
    });

    it("keeps PARALLEL tool replies bound to their assistant (the shape that broke production)", () => {
        // The real-world failure: one assistant emits several tool_calls, each
        // answered by its own `tool` message. The pre-fix window cut BETWEEN two
        // sibling tool replies, leaving the oldest survivor a `tool` whose
        // assistant had been dropped — a 400 with no assistant prose required.
        // This is what agent `typescript-deepseek` hit (13 tool calls / 9 model calls).
        const calls = [0, 1, 2].map(k => ({
            id: `c_${k}`,
            server: "filesystem",
            tool: "read_text_file",
            arguments: { path: `/f${k}.ts` },
        }));

        const messages: Message[] = [
            system("sys"),
            user("older turn"),
            { ...base(), role: "assistant", content: "", toolCalls: calls },
            ...calls.map(c => toolReply(c.id, { content: "x".repeat(8_000) })),
            user("newest question"),
        ];

        const windowed = windowMessages(messages, 500);

        assertNoOrphanedToolMessages(windowed);
        // The whole oversized unit goes, or all of it stays — never a partial cut.
        const toolCount = windowed.filter(m => m.role === "tool").length;
        expect(toolCount === 0 || toolCount === calls.length).toBe(true);
    });

    it("keeps an assistant+tool unit together when it fits", () => {
        const messages: Message[] = [
            system("sys"),
            assistantCalling("call_1"),
            toolReply("call_1", { small: true }),
            user("newest"),
        ];

        const windowed = windowMessages(messages, 10_000);

        expect(windowed.map(m => m.role)).toEqual(["system", "assistant", "tool", "user"]);
        assertNoOrphanedToolMessages(windowed);
    });
});
