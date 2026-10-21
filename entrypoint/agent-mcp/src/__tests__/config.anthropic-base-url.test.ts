/**
 * guards: a user-supplied ADHD_AGENT_ANTHROPIC_BASE_URL reaches the Anthropic SDK doubled as `<origin>/v1`
 * (getProviderConfig's OpenAI-style `/v1` normalization), so requests hit `/v1/v1/messages` and every custom
 * Anthropic endpoint (proxy, gateway, mock) 404s.
 * tier: S
 * cites: backlog 760ca534 (AC1 anthropic origin passed through unchanged; AC2 a trailing /v1 is stripped;
 *   AC3 a path prefix is kept; AC4 openai/deepseek keep the /v1 normalization).
 * red run: with the pre-fix `normalizeBaseUrl` applied to every provider, AC1 fails
 *   (`expected "http://127.0.0.1:9" received "http://127.0.0.1:9/v1"`) and AC2 fails; AC3 and AC4 stay green.
 *
 * The Anthropic SDK appends `/v1/messages` to its `baseURL` itself, so the value handed to it must be the
 * ORIGIN (plus any proxy path prefix) and never end in `/v1`. This drives the real, unmodified `config.ts`
 * (`env.getProviderConfig`) with real process env; nothing about URL resolution is mocked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VARS = [
    "ADHD_AGENT_ANTHROPIC_SECRET",
    "ADHD_AGENT_ANTHROPIC_BASE_URL",
    "ADHD_AGENT_OPENAI_SECRET",
    "ADHD_AGENT_OPENAI_BASE_URL",
    "ADHD_AGENT_DEEPSEEK_SECRET",
    "ADHD_AGENT_DEEPSEEK_BASE_URL",
];

const cleanup: string[] = [];
let originalCwd: string;

beforeEach(() => {
    originalCwd = process.cwd();
    // An empty cwd and an isolated $HOME so no real .env file feeds the resolver.
    const dir = mkdtempSync(join(tmpdir(), "adhd-agent-mcp-baseurl-"));
    cleanup.push(dir);
    process.chdir(dir);
    vi.resetModules();
    vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => dir, default: { ...actual, homedir: () => dir } };
    });
    for (const name of VARS) delete process.env[name];
    // Placeholder secrets (not shaped like real credentials, so the secret scanner stays quiet).
    process.env.ADHD_AGENT_ANTHROPIC_SECRET = "TESTFIXTURE-anthropic";
    process.env.ADHD_AGENT_OPENAI_SECRET = "TESTFIXTURE-openai";
    process.env.ADHD_AGENT_DEEPSEEK_SECRET = "TESTFIXTURE-deepseek";
});

afterEach(() => {
    process.chdir(originalCwd);
    vi.doUnmock("node:os");
    vi.resetModules();
    for (const name of VARS) delete process.env[name];
    while (cleanup.length > 0) {
        const dir = cleanup.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

async function resolveFor(provider: "anthropic" | "openai" | "deepseek", baseUrl: string | undefined) {
    const name = `ADHD_AGENT_${provider.toUpperCase()}_BASE_URL`;
    if (baseUrl !== undefined) process.env[name] = baseUrl;
    const { env } = await import("../config.js");
    return env.getProviderConfig({ provider });
}

describe("760ca534 — Anthropic base URL is handed to the SDK as an origin, never as <origin>/v1", () => {
    it("AC1: a bare origin is passed through unchanged", async () => {
        expect((await resolveFor("anthropic", "http://127.0.0.1:9")).baseURL).toBe("http://127.0.0.1:9");
    });

    it("AC2: a trailing /v1 (with or without a slash) is stripped", async () => {
        expect((await resolveFor("anthropic", "https://gateway.example.test/v1")).baseURL).toBe("https://gateway.example.test");
        vi.resetModules();
        expect((await resolveFor("anthropic", "https://gateway.example.test/v1/")).baseURL).toBe("https://gateway.example.test");
    });

    it("AC3: a proxy path prefix is kept", async () => {
        expect((await resolveFor("anthropic", "https://gateway.example.test/anthropic")).baseURL).toBe("https://gateway.example.test/anthropic");
    });

    it("AC4: unset keeps the SDK default (no baseURL at all)", async () => {
        expect((await resolveFor("anthropic", undefined)).baseURL).toBeUndefined();
    });

    it("negative control: openai and deepseek keep the /v1 normalization their clients rely on", async () => {
        expect((await resolveFor("openai", "http://127.0.0.1:9")).baseURL).toBe("http://127.0.0.1:9/v1");
        vi.resetModules();
        expect((await resolveFor("deepseek", "http://127.0.0.1:9")).baseURL).toBe("http://127.0.0.1:9/v1");
    });
});
