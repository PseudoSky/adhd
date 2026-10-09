/**
 * c536ce29 F1-AC-A / 03be90c3 S8B — host -> engine seam: the `tempDir` the host's `createWireSeams`
 * puts on `EngineConfig.wire` is where a real `ClaudeCliProvider.chat()` writes its credential-bearing
 * scratch (mcp-config, agent-spec dir). Only `child_process.spawn` is mocked (no subprocess). The
 * injected root lives in a sandbox under `os.tmpdir()`, removed in teardown; the assertion is that the
 * files land inside the injected root and that `os.tmpdir()`'s top level gains no scratch entry.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeCliProvider } from "@adhd/agent-engine-orchestrator";
import type { EngineConfig } from "@adhd/agent-engine-orchestrator";

import { createWireSeams } from "../wire/seams.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
const noop = (): void => undefined;
const stray = (): string[] => readdirSync(tmpdir()).filter((n) => /^agent-mcp-(claudecli|spec)-/.test(n)).sort();

let sandbox: string;
beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "f1-host-temp-")));
});
afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

describe("c536ce29 F1-AC-A host-injected tempDir is where claudecli scratch lands", () => {
    it("c536ce29 F1-AC-A: a claudecli run with createWireSeams().tempDir writes mcp-config and spec dir under it, not os.tmpdir()", async () => {
        const root = join(sandbox, "namespaced", "temp");
        const wire = createWireSeams({ tempDir: root });
        const { spawn } = await import("child_process");
        let mcpConfig = "";
        let entries: string[] = [];
        (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation((_c: string, args: string[]) => {
            const i = args.indexOf("--mcp-config");
            mcpConfig = i >= 0 ? (args[i + 1] ?? "") : "";
            entries = existsSync(root) ? readdirSync(root) : [];
            const stdout = new Readable({ read: noop });
            queueMicrotask(() => {
                stdout.push(RESULT + "\n");
                stdout.push(null);
            });
            return { stdout, stdin: { write: () => true, end: noop }, stderr: new Readable({ read: noop }), pid: undefined, on: noop, kill: noop, exitCode: 0, killed: false };
        });
        const config = {
            wire,
            server: { contextLimit: 0, defaultMaxTokens: 8192 },
            queue: { concurrency: 1 },
            sse: { baseUrl: "" },
            plugins: { entries: [] },
            getProviderConfig: () => ({}),
            subprocessEnv: () => ({}),
            resolveEnvName: () => undefined,
        } as unknown as EngineConfig;
        const before = stray();
        const provider = new ClaudeCliProvider(
            { type: "claudecli", model: "claude-haiku-4-5", systemPromptIsAgentSpec: true } as never,
            { srv: { transport: "stdio", command: "node", args: ["x.js"] } } as never,
            undefined,
            config,
            { info: noop, warn: noop, error: noop, debug: noop }
        );
        await provider.chat({
            messages: [
                { role: "system", content: "---\nname: probe\ndescription: d\n---\nbody" },
                { role: "user", content: "hi" },
            ] as never,
        });
        expect(mcpConfig.startsWith(root + sep)).toBe(true);
        expect(entries.some((n) => n.startsWith("agent-mcp-claudecli-"))).toBe(true);
        expect(entries.some((n) => n.startsWith("agent-mcp-spec-"))).toBe(true);
        expect(stray()).toEqual(before);
    });
});
