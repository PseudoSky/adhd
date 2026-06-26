/**
 * claudecli agent-spec mode (`systemPromptIsAgentSpec`).
 *
 * Drives the REAL ClaudeCliProvider.chat() against a fake `claude` binary (the only
 * faked boundary). The fake records its argv and reads back the agent-spec file the
 * provider wrote, so we can assert the exact flags Claude receives. These checks
 * have teeth: if spec mode stopped emitting --add-dir/--agent, or kept emitting
 * --disallowedTools/--system-prompt, the assertions fail.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ClaudeCliProvider } from "../providers/claudecli.js";
import {
    extractAgentSpecName,
    normalizeAgentSpec,
} from "../providers/claudecli.js";
import type { Message } from "../validation/index.js";

// A fake `claude` executable: captures argv + the written agent-spec file, then
// emits a stream-json `result` so chat() resolves. Reads stdin so the provider's
// initial user-message write never hits EPIPE.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);

function flagVal(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

let specContent = null;
let specFileName = null;
const addDir = flagVal("--add-dir");
if (addDir) {
  try {
    const dir = path.join(addDir, ".claude", "agents");
    const f = fs.readdirSync(dir)[0];
    specFileName = f;
    specContent = fs.readFileSync(path.join(dir, f), "utf8");
  } catch (_) { /* none */ }
}

try {
  fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
    args,
    addDir,
    settingSources: flagVal("--setting-sources"),
    agent: flagVal("--agent"),
    systemPrompt: flagVal("--system-prompt"),
    hasDisallowed: args.includes("--disallowedTools"),
    specContent,
    specFileName,
  }));
} catch (_) { /* ignore */ }

process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
setTimeout(() => process.exit(0), 150);
`;

let workDir: string;
let fakeClaudePath: string;
let captureFile: string;
const prevAuth = process.env["ANTHROPIC_AUTH_TOKEN"];

beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claudecli-spec-test-"));
    fakeClaudePath = join(workDir, "fake-claude.js");
    captureFile = join(workDir, "capture.json");
    await writeFile(fakeClaudePath, FAKE_CLAUDE, "utf8");
    await chmod(fakeClaudePath, 0o755);
    // Avoid keychain reads in buildSubprocessEnv.
    process.env["ANTHROPIC_AUTH_TOKEN"] = "test-token";
});

afterAll(async () => {
    if (prevAuth === undefined) delete process.env["ANTHROPIC_AUTH_TOKEN"];
    else process.env["ANTHROPIC_AUTH_TOKEN"] = prevAuth;
    await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
    delete process.env["CAPTURE_FILE"];
    await rm(captureFile, { force: true });
});

async function runChat(systemPrompt: string, systemPromptIsAgentSpec: boolean) {
    process.env["CAPTURE_FILE"] = captureFile;
    const provider = new ClaudeCliProvider({
        type: "claudecli",
        claudePath: fakeClaudePath,
        systemPromptIsAgentSpec,
    });
    const messages: Message[] = [
        { id: "s", sessionId: "x", role: "system", content: systemPrompt, createdAt: "" },
        { id: "u", sessionId: "x", role: "user", content: "do the thing", createdAt: "" },
    ];
    const res = await provider.chat({ messages });
    const capture = JSON.parse(await readFile(captureFile, "utf8"));
    return { res, capture };
}

const AGENT_MD = `---
name: my-runner
description: runs delegated tasks
tools: Read, Grep
---
You are a careful task runner.`;

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("extractAgentSpecName", () => {
    it("reads the frontmatter name", () => {
        expect(extractAgentSpecName(AGENT_MD)).toBe("my-runner");
    });
    it("strips surrounding quotes", () => {
        expect(extractAgentSpecName(`---\nname: "quoted-name"\n---\nbody`)).toBe("quoted-name");
    });
    it("returns undefined with no frontmatter", () => {
        expect(extractAgentSpecName("just a plain prompt")).toBeUndefined();
    });
    it("returns undefined when frontmatter lacks a name", () => {
        expect(extractAgentSpecName(`---\ndescription: x\n---\nbody`)).toBeUndefined();
    });
});

describe("normalizeAgentSpec", () => {
    it("passes through markdown that already names the agent", () => {
        const out = normalizeAgentSpec(AGENT_MD);
        expect(out.agentName).toBe("my-runner");
        expect(out.content).toBe(AGENT_MD); // unchanged → author's tools header preserved
    });
    it("injects a name into nameless frontmatter", () => {
        const out = normalizeAgentSpec(`---\ntools: Read\n---\nbody`);
        expect(out.agentName).toBe("agent-mcp-runner");
        expect(out.content).toContain("name: agent-mcp-runner");
        expect(out.content).toContain("tools: Read"); // preserves the header
    });
    it("wraps a plain prompt with minimal frontmatter", () => {
        const out = normalizeAgentSpec("plain prompt, no header");
        expect(out.agentName).toBe("agent-mcp-runner");
        expect(out.content.startsWith("---\nname: agent-mcp-runner")).toBe(true);
        expect(out.content).toContain("plain prompt, no header");
    });
});

// ─── provider arg construction (real subprocess) ──────────────────────────────

describe("ClaudeCliProvider — agent-spec mode flags", () => {
    it("spec mode: defers tools to the agent header (--add-dir/--agent, no --disallowedTools/--system-prompt)", async () => {
        const { res, capture } = await runChat(AGENT_MD, true);

        expect(res.stopReason).toBe("completed");
        expect(res.message.content).toBe("ok");

        // Header-driven path is wired:
        expect(capture.addDir).toBeTruthy();
        expect(capture.settingSources).toBe("project");
        expect(capture.agent).toBe("my-runner"); // selected by frontmatter name

        // The spec header is the single source of truth — NOT the denylist:
        expect(capture.hasDisallowed).toBe(false);
        expect(capture.systemPrompt).toBeNull();

        // Claude actually receives the authored markdown (so it can parse `tools:`):
        expect(capture.specContent).toBe(AGENT_MD);
    });

    it("legacy mode: enumerates --disallowedTools + --system-prompt, no agent-spec flags", async () => {
        const { capture } = await runChat(AGENT_MD, false);

        expect(capture.hasDisallowed).toBe(true);
        expect(capture.systemPrompt).toBe(AGENT_MD);
        expect(capture.addDir).toBeNull();
        expect(capture.agent).toBeNull();
    });
});
