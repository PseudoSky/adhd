/**
 * Shared helpers for the wire-wrapper tests (backlog c536ce29, W1): a real file-backed api log
 * channel in an isolated temp dir, and a reader for the records it wrote.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogChannel, createRedactor, type LogChannel, type Redactor } from "@adhd/agent-plugin-tracing";

export type Rec = Record<string, unknown> & { event: string };

export interface ITestChannel {
    channel: LogChannel;
    dir: string;
    /** Flushes and returns every record written so far, in file order. */
    records(): Promise<Rec[]>;
    /** Flushes and returns the raw text of every channel file. */
    rawText(): Promise<string>;
    dispose(): Promise<void>;
}

/** A real api channel (sync durability so tests are deterministic) over a fresh temp dir. */
export function makeTestChannel(opts: { redactor?: Redactor; bodyMaxBytes?: number; knownSecrets?: string[] } = {}): ITestChannel {
    const dir = mkdtempSync(join(tmpdir(), "wire-w1-"));
    const channel = createLogChannel({
        dir,
        component: "agent-mcp.api",
        fileLabel: "test",
        durability: { mode: "sync" },
        redactor: opts.redactor ?? createRedactor({ knownSecrets: opts.knownSecrets ?? [] }),
        ...(opts.bodyMaxBytes !== undefined ? { bodyMaxBytes: opts.bodyMaxBytes } : {}),
    });
    const rawText = async (): Promise<string> => {
        await channel.flush();
        return readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .sort()
            .map((f) => readFileSync(join(dir, f), "utf8"))
            .join("");
    };
    return {
        channel,
        dir,
        rawText,
        async records() {
            return (await rawText())
                .split("\n")
                .filter((l) => l.length > 0)
                .map((l) => JSON.parse(l) as Rec);
        },
        async dispose() {
            await channel.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Polls `fn` until it returns a defined value or the deadline passes (bounded, no fixed sleeps). */
export async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, deadlineMs = 5000): Promise<T> {
    const end = Date.now() + deadlineMs;
    for (;;) {
        const v = await fn();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setImmediate(r));
    }
}
