/**
 * guards: clipForStorage returns text longer than its bound, splits a surrogate pair, drops the head or tail, or is not idempotent, so a stored TOOL_RESULT row or a task_events field exceeds 16000 chars
 * tier: S
 * cites: plan discovery-sweep-1014 blind-review A2 TEB-A3
 *
 * plan discovery-sweep-1014 blind-review A2 TEB-A3 — pure unit tests of `clipForStorage` and
 * `TOOL_RESULT_EVENT_MAX_CHARS` (no I/O).
 *
 * Failure modes: (a) a boundary off-by-one (a text of exactly `max` chars is clipped, or `max + 1` is not);
 * (b) the marker is added outside the bound, so the output is longer than `max` and a second clip changes it;
 * (c) a surrogate pair is cut in half at the head or tail edge, leaving a lone surrogate that `JSON.stringify`
 * would emit as an escape and that corrupts the stored text; (d) a `max` smaller than the marker throws, loops, or
 * returns a negative-length slice; (e) head or tail is lost (the stored text must show both ends).
 * Red run: against the pre-change tree `clipForStorage` does not exist, so every case fails at import
 * (`clipForStorage is not a function`); against a variant that places the marker outside the bound the
 * `length <= max` and idempotence cases fail on their assertions.
 */
import { describe, expect, it } from "vitest";

import { clipForStorage, TOOL_RESULT_EVENT_MAX_CHARS } from "../engine/tool-result-cap.js";

const isLoneSurrogate = (text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = text.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            i += 1;
        } else if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
};

describe("plan discovery-sweep-1014 blind-review A2 TEB-A3 clipForStorage", () => {
    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: the event bound is 16,000 code units", () => {
        expect(TOOL_RESULT_EVENT_MAX_CHARS).toBe(16_000);
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: length === max is returned untouched; max + 1 is clipped", () => {
        const max = 1_000;
        const at = "a".repeat(max);
        const over = "a".repeat(max + 1);
        expect(clipForStorage(at, max)).toEqual({ text: at, clipped: false, originalChars: max });
        const clipped = clipForStorage(over, max);
        expect(clipped.clipped).toBe(true);
        expect(clipped.originalChars).toBe(max + 1);
        expect(clipped.text.length).toBeLessThanOrEqual(max);
        expect(clipped.text).not.toBe(over);
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: the marker counts inside max, names head/tail/total, and both ends survive", () => {
        const max = 2_000;
        const text = `HEAD${"m".repeat(50_000)}TAIL`;
        const { text: out } = clipForStorage(text, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out.startsWith("HEAD")).toBe(true);
        expect(out.endsWith("TAIL")).toBe(true);
        const m = /\[stored text clipped: showing first (\d+) and last (\d+) of (\d+) chars\]/.exec(out);
        expect(m).not.toBeNull();
        expect(Number(m![3])).toBe(text.length);
        const headLen = Number(m![1]);
        const tailLen = Number(m![2]);
        expect(out.startsWith(text.slice(0, headLen))).toBe(true);
        expect(out.endsWith(text.slice(text.length - tailLen))).toBe(true);
        // head gets about three quarters of the room, tail the rest
        expect(headLen).toBeGreaterThan(tailLen * 2);
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: ASCII text well over the bound is clipped to exactly the bound (no unused room)", () => {
        for (const n of [16_001, 100_000, 307_200, 5_000_000]) {
            expect(clipForStorage("k".repeat(n), 16_000).text).toHaveLength(16_000);
        }
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: idempotent for many sizes (clip of a clip is the clip)", () => {
        for (const max of [200, 1_000, 16_000]) {
            for (const n of [max + 1, max * 3, 123_456]) {
                const once = clipForStorage("x".repeat(n), max);
                const twice = clipForStorage(once.text, max);
                expect(twice.clipped).toBe(false);
                expect(twice.text).toBe(once.text);
                expect(once.text.length).toBeLessThanOrEqual(max);
            }
        }
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: never splits a surrogate pair at the head or tail cut, for every shift of the cut", () => {
        const pair = "\u{1F600}"; // 2 code units
        const max = 400;
        for (let shift = 0; shift < 4; shift++) {
            const text = "a".repeat(shift) + pair.repeat(5_000);
            const { text: out, clipped } = clipForStorage(text, max);
            expect(clipped).toBe(true);
            expect(out.length).toBeLessThanOrEqual(max);
            expect(isLoneSurrogate(out)).toBe(false);
        }
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: a max smaller than the marker yields a bounded, surrogate-safe head slice", () => {
        const text = "\u{1F600}".repeat(500);
        for (const max of [0, 1, 2, 3, 10, 30]) {
            const { text: out, clipped, originalChars } = clipForStorage(text, max);
            expect(clipped).toBe(true);
            expect(originalChars).toBe(text.length);
            expect(out.length).toBeLessThanOrEqual(max);
            expect(isLoneSurrogate(out)).toBe(false);
            expect(text.startsWith(out)).toBe(true);
        }
    });

    it("plan discovery-sweep-1014 blind-review A2 TEB-A3: an empty string is unclipped", () => {
        expect(clipForStorage("", 10)).toEqual({ text: "", clipped: false, originalChars: 0 });
    });
});
