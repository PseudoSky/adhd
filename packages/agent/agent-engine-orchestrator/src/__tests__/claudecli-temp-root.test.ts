import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";

/**
 * c536ce29 / 03be90c3 S8B-AC2 (claudecli): the generated mcp-config file and agent-spec dir land
 * under the host-injected namespaced temp root (`EngineConfig.wire.tempDir`), NOT the OS temp dir.
 *
 * Drives the real `ClaudeCliProvider.chat()`; only `child_process.spawn` is mocked (no subprocess).
 * The sandbox lives under `os.tmpdir()`, so "not under tmpdir" proves nothing — the assertions are
 * (1) the paths are inside the injected root and (2) the top level of `os.tmpdir()` gains no
 * `agent-mcp-claudecli-*` / `agent-mcp-spec-*` entry.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const under = (child: string, parent: string): boolean => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const strayInOsTmp = (): string[] => readdirSync(tmpdir()).filter((n) => /^agent-mcp-(claudecli|spec)-/.test(n)).sort();

function fakeProc() {
    const stdout = new Readable({ read() {} });
    queueMicrotask(() => {
        stdout.push(RESULT_LINE + "\n");
        stdout.push(null);
    });
    return {
        stdout,
        stdin: { write: () => true, end: () => {} },
        stderr: new Readable({ read() {} }),
        pid: undefined,
        on: () => {},
        kill: () => {},
        exitCode: 0 as number | null,
        killed: false,
    };
}

function makeConfig(tempDir: string | undefined): EngineConfig {
    return {
        wire: tempDir === undefined ? undefined : { tempDir },
        server: { contextLimit: 0, defaultMaxTokens: 8192 },
        queue: { concurrency: 1 },
        sse: { baseUrl: "" },
        plugins: { entries: [] },
        getProviderConfig: () => ({}),
        subprocessEnv: () => ({}),
        resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
    } as unknown as EngineConfig;
}

let sandbox: string;
beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "s8b-claudecli-")));
});
afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

/** Runs one spec-mode chat and reports what existed at spawn time (before cleanup). */
async function chatAndObserve(tempDir: string | undefined) {
    const { spawn } = await import("child_process");
    const seen: { args: string[]; rootEntries: string[]; mcpConfigExisted: boolean; mcpConfig: string } = {
        args: [], rootEntries: [], mcpConfigExisted: false, mcpConfig: "",
    };
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation((_cmd: string, args: string[]) => {
        seen.args = args;
        const i = args.indexOf("--mcp-config");
        seen.mcpConfig = i >= 0 ? (args[i + 1] ?? "") : "";
        seen.mcpConfigExisted = seen.mcpConfig !== "" && existsSync(seen.mcpConfig);
        if (tempDir !== undefined && existsSync(tempDir)) seen.rootEntries = readdirSync(tempDir).sort();
        return fakeProc();
    });
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const provider = new ClaudeCliProvider(
        { type: "claudecli", model: "claude-haiku-4-5", systemPromptIsAgentSpec: true } as never,
        { srv: { transport: "stdio", command: "node", args: ["x.js"] } } as never,
        undefined,
        makeConfig(tempDir),
        logger,
    );
    await provider.chat({
        messages: [
            { role: "system", content: "---\nname: probe\ndescription: d\n---\nbody" },
            { role: "user", content: "hi" },
        ] as never,
    });
    return seen;
}

describe("c536ce29 S8B-AC2 claudecli temp files land under the injected namespaced temp root", () => {
    it("c536ce29 S8B-AC2: mcp-config and agent-spec dir are created inside wire.tempDir (created on demand), not os.tmpdir()", async () => {
        const root = join(sandbox, "namespaced", "temp"); // does not exist yet: provider must create it
        const before = strayInOsTmp();
        const seen = await chatAndObserve(root);

        expect(seen.mcpConfigExisted).toBe(true);
        expect(under(seen.mcpConfig, root)).toBe(true);
        expect(seen.rootEntries.some((n) => n.startsWith("agent-mcp-claudecli-"))).toBe(true);
        expect(seen.rootEntries.some((n) => n.startsWith("agent-mcp-spec-"))).toBe(true);
        expect(strayInOsTmp()).toEqual(before);
    });
});
