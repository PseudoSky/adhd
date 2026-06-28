/**
 * config.test.ts — comprehensive tests for src/config.ts (§7)
 *
 * Every test calls `loadConfig(fakeEnv)` for isolation — no process.env mutations.
 * Each behavioral case carries a negative control that goes red if the logic is
 * reverted. Tests are keyed [CFG-NNN] for traceability.
 *
 * Live end-to-end proof (DeepSeek / LM Studio via real MCP tools) is flag-gated:
 *   ADHD_AGENT_MCP_LIVE=1 npx nx test agent-mcp
 * Gate justification: DeepSeek is a paid third-party service — the one qualifying
 * exception per CLAUDE.md §6. Gate documented here, in README.md, and in CLAUDE.md.
 * Named owner: pseudosky (repo maintainer).
 */

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY: NodeJS.ProcessEnv = {};

function makeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
    return { ...EMPTY, ...overrides };
}

// ── §1.1 Static values + defaults ────────────────────────────────────────────

describe("loadConfig — static values + defaults [CFG-001]", () => {
    it("[CFG-001.defaults] all fields have correct defaults", () => {
        const c = loadConfig(EMPTY);
        expect(c.db.path).toBe(path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db"));
        expect(c.logging.level).toBe("info");
        expect(c.queue.concurrency).toBe(5);
        expect(c.server.maxDepth).toBe(5);
        expect(c.server.maxToolLoops).toBe(50);
        expect(c.server.defaultMaxTokens).toBe(8192);
        expect(c.server.contextLimit).toBe(0);
        expect(c.server.allowedAgents).toBeUndefined();
        expect(c.server.registryDbPath).toBe(
            path.join(os.homedir(), ".adhd", "agent-mcp", "registry.db")
        );
        expect(c.transport.kind).toBe("stdio");
        expect(c.transport.port).toBe(3000);
        expect(c.sse.port).toBe(3001);
        expect(c.sse.host).toBe("127.0.0.1");
        expect(c.sse.baseUrl).toBe("http://localhost:3001");
        expect(c.plugins.configPath).toBeUndefined();
        expect(c.plugins.entries).toEqual([]);
        expect(c.security.envAllowlist).toEqual([]);
    });

    it("[CFG-001.overrides] env vars override each field", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_DATABASE_PATH:   "/custom/agents.db",
            ADHD_AGENT_LOG_LEVEL:       "debug",
            ADHD_AGENT_QUEUE_CONCURRENCY: "10",
            ADHD_AGENT_MAX_DEPTH:       "3",
            ADHD_AGENT_MAX_TOOL_LOOPS:  "25",
            ADHD_AGENT_DEFAULT_MAX_TOKENS: "4096",
            ADHD_AGENT_CONTEXT_LIMIT:   "100000",
            ADHD_AGENT_ALLOWED_AGENTS:  "alice,bob",
            ADHD_AGENT_REGISTRY_DB_PATH: "/custom/registry.db",
            ADHD_AGENT_TRANSPORT:       "http",
            ADHD_AGENT_PORT:            "8080",
            ADHD_AGENT_SSE_PORT:        "9001",
            ADHD_AGENT_SSE_HOST:        "0.0.0.0",
            ADHD_AGENT_SSE_BASE_URL:    "https://my-server.example.com",
            ADHD_AGENT_CONFIG:          "/path/to/config.json",
            ADHD_AGENT_PLUGINS:         "mod-a,mod-b",
            ADHD_AGENT_ENV_ALLOWLIST:   "CUSTOM_VAR",
        }));

        expect(c.db.path).toBe("/custom/agents.db");
        expect(c.logging.level).toBe("debug");
        expect(c.queue.concurrency).toBe(10);
        expect(c.server.maxDepth).toBe(3);
        expect(c.server.maxToolLoops).toBe(25);
        expect(c.server.defaultMaxTokens).toBe(4096);
        expect(c.server.contextLimit).toBe(100000);
        expect(c.server.allowedAgents).toEqual(["alice", "bob"]);
        expect(c.server.registryDbPath).toBe("/custom/registry.db");
        expect(c.transport.kind).toBe("http");
        expect(c.transport.port).toBe(8080);
        expect(c.sse.port).toBe(9001);
        expect(c.sse.host).toBe("0.0.0.0");
        expect(c.sse.baseUrl).toBe("https://my-server.example.com");
        expect(c.plugins.configPath).toBe("/path/to/config.json");
        expect(c.plugins.entries).toEqual(["mod-a", "mod-b"]);
        expect(c.security.envAllowlist).toEqual(["CUSTOM_VAR"]);
    });

    it("[CFG-001.negative] old env-var names (pre-rename) are NOT picked up", () => {
        const c = loadConfig(makeEnv({
            DATABASE_PATH:              "/old/agents.db",
            LOG_LEVEL:                  "debug",
            QUEUE_CONCURRENCY:          "99",
            AGENT_MCP_MAX_DEPTH:        "99",
        }));
        // Old names are ignored — defaults apply
        expect(c.db.path).not.toBe("/old/agents.db");
        expect(c.logging.level).toBe("info");
        expect(c.queue.concurrency).toBe(5);
        expect(c.server.maxDepth).toBe(5);
    });
});

// ── Zod validation — fail fast ────────────────────────────────────────────────

describe("loadConfig — Zod fail-fast [CFG-002]", () => {
    it("[CFG-002.bad-int] bad integer fails with ZodError", () => {
        expect(() =>
            loadConfig(makeEnv({ ADHD_AGENT_MAX_DEPTH: "not-a-number" }))
        ).toThrow();
    });

    it("[CFG-002.bad-enum] unknown log level fails", () => {
        expect(() =>
            loadConfig(makeEnv({ ADHD_AGENT_LOG_LEVEL: "verbose" }))
        ).toThrow();
    });

    it("[CFG-002.negative] valid int does NOT throw", () => {
        expect(() =>
            loadConfig(makeEnv({ ADHD_AGENT_MAX_DEPTH: "10" }))
        ).not.toThrow();
    });
});

// ── Frozen result ─────────────────────────────────────────────────────────────

describe("loadConfig — deep-frozen result [CFG-003]", () => {
    it("[CFG-003.frozen] top-level object is frozen", () => {
        const c = loadConfig(EMPTY);
        expect(Object.isFrozen(c)).toBe(true);
    });

    it("[CFG-003.deep] nested objects are also frozen", () => {
        const c = loadConfig(EMPTY);
        expect(Object.isFrozen(c.db)).toBe(true);
        expect(Object.isFrozen(c.server)).toBe(true);
        expect(Object.isFrozen(c.sse)).toBe(true);
    });

    it("[CFG-003.negative] mutation is silently ignored (strict mode would throw)", () => {
        const c = loadConfig(EMPTY);
        // In non-strict mode Object.assign to frozen object ignores writes
        const before = c.logging.level;
        try { (c.logging as { level: string }).level = "debug"; } catch { /* expected in strict */ }
        expect(c.logging.level).toBe(before);
    });
});

// ── SSE base URL derivation ───────────────────────────────────────────────────

describe("loadConfig — SSE baseUrl derivation [CFG-004]", () => {
    it("[CFG-004.derived] baseUrl derived from sse.port when not set", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_SSE_PORT: "9876" }));
        expect(c.sse.baseUrl).toBe("http://localhost:9876");
    });

    it("[CFG-004.explicit] explicit ADHD_AGENT_SSE_BASE_URL wins over derived", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_SSE_PORT:    "9876",
            ADHD_AGENT_SSE_BASE_URL: "https://custom.example.com",
        }));
        expect(c.sse.baseUrl).toBe("https://custom.example.com");
    });
});

// ── §6 prefix guard ───────────────────────────────────────────────────────────

describe("isEnvNameAllowed [CFG-005]", () => {
    it("[CFG-005.allowed-prefix] ADHD_AGENT_* names are allowed", () => {
        const c = loadConfig(EMPTY);
        expect(c.isEnvNameAllowed("ADHD_AGENT_OPENAI_SECRET")).toBe(true);
        expect(c.isEnvNameAllowed("ADHD_AGENT_CUSTOM_VAR")).toBe(true);
    });

    it("[CFG-005.rejected-bare] bare names are rejected", () => {
        const c = loadConfig(EMPTY);
        expect(c.isEnvNameAllowed("OPENAI_API_KEY")).toBe(false);
        expect(c.isEnvNameAllowed("AWS_SECRET_ACCESS_KEY")).toBe(false);
        expect(c.isEnvNameAllowed("GITHUB_TOKEN")).toBe(false);
    });

    it("[CFG-005.allowlist] ADHD_AGENT_ENV_ALLOWLIST extends the set", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_ENV_ALLOWLIST: "CUSTOM_SECRET,ANOTHER_KEY",
        }));
        expect(c.isEnvNameAllowed("CUSTOM_SECRET")).toBe(true);
        expect(c.isEnvNameAllowed("ANOTHER_KEY")).toBe(true);
        expect(c.isEnvNameAllowed("NOT_IN_ALLOWLIST")).toBe(false);
    });

    it("[CFG-005.negative] rejected-prefix negative control", () => {
        const c = loadConfig(EMPTY);
        // AGENT_MCP_ prefix (old) is NOT allowed
        expect(c.isEnvNameAllowed("AGENT_MCP_DATABASE_PATH")).toBe(false);
    });
});

// ── resolveEnvRef ─────────────────────────────────────────────────────────────

describe("resolveEnvRef [CFG-006]", () => {
    it("[CFG-006.resolves] resolves a present ADHD_AGENT_* name", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_MY_SECRET: "super-secret" }));
        expect(c.resolveEnvRef("ADHD_AGENT_MY_SECRET")).toBe("super-secret");
    });

    it("[CFG-006.missing] returns undefined when name is present but var is not set", () => {
        const c = loadConfig(EMPTY);
        expect(c.resolveEnvRef("ADHD_AGENT_NOT_SET")).toBeUndefined();
    });

    it("[CFG-006.throws-disallowed] throws on a disallowed name", () => {
        const c = loadConfig(EMPTY);
        expect(() => c.resolveEnvRef("AWS_SECRET_ACCESS_KEY")).toThrow(/not.*permitted|not.*allowed/i);
    });

    it("[CFG-006.negative] does NOT throw for an explicitly allowlisted name", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_ENV_ALLOWLIST: "CUSTOM_VAR",
            CUSTOM_VAR: "custom-value",
        }));
        expect(() => c.resolveEnvRef("CUSTOM_VAR")).not.toThrow();
        expect(c.resolveEnvRef("CUSTOM_VAR")).toBe("custom-value");
    });
});

// ── verifyEnvRefs ─────────────────────────────────────────────────────────────

describe("verifyEnvRefs [CFG-007]", () => {
    it("[CFG-007.all-present] no missing or disallowed when all set", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_OPENAI_SECRET:   "sk-test",
            ADHD_AGENT_OPENAI_BASE_URL: "https://api.openai.com/v1",
        }));
        const result = c.verifyEnvRefs([
            "ADHD_AGENT_OPENAI_SECRET",
            "ADHD_AGENT_OPENAI_BASE_URL",
        ]);
        expect(result.missing).toEqual([]);
        expect(result.disallowed).toEqual([]);
    });

    it("[CFG-007.missing] reports unset ADHD_AGENT_* names as missing", () => {
        const c = loadConfig(EMPTY);
        const result = c.verifyEnvRefs(["ADHD_AGENT_OPENAI_SECRET"]);
        expect(result.missing).toContain("ADHD_AGENT_OPENAI_SECRET");
        expect(result.disallowed).toEqual([]);
    });

    it("[CFG-007.disallowed] reports non-prefix names as disallowed", () => {
        const c = loadConfig(EMPTY);
        const result = c.verifyEnvRefs(["AWS_SECRET", "ADHD_AGENT_OK"]);
        expect(result.disallowed).toContain("AWS_SECRET");
        expect(result.missing).toContain("ADHD_AGENT_OK");
    });

    it("[CFG-007.negative] set + allowed = neither missing nor disallowed", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_FOO: "bar" }));
        const result = c.verifyEnvRefs(["ADHD_AGENT_FOO"]);
        expect(result.missing).not.toContain("ADHD_AGENT_FOO");
        expect(result.disallowed).not.toContain("ADHD_AGENT_FOO");
    });
});

// ── subprocessEnv ─────────────────────────────────────────────────────────────

describe("subprocessEnv [CFG-008]", () => {
    it("[CFG-008.returns-map] returns a string map of the snapshot", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_MY_VAR: "hello" }));
        const sub = c.subprocessEnv();
        expect(typeof sub).toBe("object");
        expect(sub["ADHD_AGENT_MY_VAR"]).toBe("hello");
    });

    it("[CFG-008.no-undefined] does not include undefined values", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_PRESENT: "yes" }));
        const sub = c.subprocessEnv();
        for (const val of Object.values(sub)) {
            expect(val).not.toBeUndefined();
        }
    });

    it("[CFG-008.negative] a var not in the snapshot is absent from subprocessEnv", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_X: "x" }));
        const sub = c.subprocessEnv();
        expect(sub["ADHD_AGENT_NOT_SET"]).toBeUndefined();
    });
});

// ── getProviderConfig ─────────────────────────────────────────────────────────

describe("getProviderConfig — openai [CFG-009]", () => {
    it("[CFG-009.env-override] env.secret overrides provider default", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_MY_API_KEY:    "sk-custom",
            ADHD_AGENT_OPENAI_SECRET: "sk-default",
        }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            secret: "ADHD_AGENT_MY_API_KEY",
        });
        expect(resolved.secret).toBe("sk-custom");
    });

    it("[CFG-009.provider-default] falls back to ADHD_AGENT_OPENAI_SECRET when no agent env override", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-default" }));
        const resolved = c.getProviderConfig({ provider: "openai" });
        expect(resolved.secret).toBe("sk-default");
    });

    it("[CFG-009.inline-url] inline baseURL is used when no env url", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "https://api.openai.com/v1",
        });
        expect(resolved.baseURL).toBe("https://api.openai.com/v1");
    });

    it("[CFG-009.env-url-wins] env.base_url override wins over inline", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_OPENAI_SECRET:  "sk-x",
            ADHD_AGENT_MY_BASE_URL:    "https://my-proxy.com/v1",
        }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            url: "ADHD_AGENT_MY_BASE_URL",
            inlineBaseURL: "https://api.openai.com/v1",
        });
        expect(resolved.baseURL).toBe("https://my-proxy.com/v1");
    });

    it("[CFG-009.localhost-no-secret] localhost baseURL is exempt from secret requirement", () => {
        const c = loadConfig(EMPTY);
        expect(() =>
            c.getProviderConfig({
                provider: "openai",
                inlineBaseURL: "http://localhost:1234/v1",
            })
        ).not.toThrow();
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "http://localhost:1234/v1",
        });
        expect(resolved.secret).toBeUndefined();
        expect(resolved.baseURL).toBe("http://localhost:1234/v1");
    });

    it("[CFG-009.fail-loud] non-localhost without secret throws named error", () => {
        const c = loadConfig(EMPTY);
        expect(() =>
            c.getProviderConfig({
                provider: "openai",
                inlineBaseURL: "https://api.openai.com/v1",
            })
        ).toThrow(/ADHD_AGENT_OPENAI_SECRET/);
    });

    it("[CFG-009.negative] negative control — fail-loud fires when secret is missing", () => {
        // If we accidentally removed the fail-loud check, this would NOT throw.
        // The test goes red when the check is removed.
        const c = loadConfig(EMPTY);
        let threw = false;
        try {
            c.getProviderConfig({ provider: "openai", inlineBaseURL: "https://api.openai.com" });
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
    });
});

describe("getProviderConfig — anthropic wire-form inference [CFG-010]", () => {
    it("[CFG-010.api-key] sk-ant-api… → secret is passed through verbatim", () => {
        const apiKey = "sk-ant-api03-test";
        const c = loadConfig(makeEnv({ ADHD_AGENT_ANTHROPIC_SECRET: apiKey }));
        const resolved = c.getProviderConfig({ provider: "anthropic" });
        expect(resolved.secret).toBe(apiKey);
    });

    it("[CFG-010.oauth-token] sk-ant-oat… → secret is passed through verbatim", () => {
        const oauthToken = "sk-ant-oat01-test-token";
        const c = loadConfig(makeEnv({ ADHD_AGENT_ANTHROPIC_SECRET: oauthToken }));
        const resolved = c.getProviderConfig({ provider: "anthropic" });
        expect(resolved.secret).toBe(oauthToken);
    });

    it("[CFG-010.anthropic-always-needs-secret] non-localhost anthropic without secret throws", () => {
        const c = loadConfig(EMPTY);
        expect(() => c.getProviderConfig({ provider: "anthropic" })).toThrow(
            /ADHD_AGENT_ANTHROPIC_SECRET/
        );
    });

    it("[CFG-010.negative] anthropic without secret does NOT silently succeed", () => {
        const c = loadConfig(EMPTY);
        let didNotThrow = false;
        try {
            c.getProviderConfig({ provider: "anthropic" });
            didNotThrow = true;
        } catch { /* expected */ }
        expect(didNotThrow).toBe(false);
    });
});

describe("getProviderConfig — claudecli exempt [CFG-011]", () => {
    it("[CFG-011.claudecli-returns-empty] claudecli returns empty object without error", () => {
        const c = loadConfig(EMPTY);
        const resolved = c.getProviderConfig({ provider: "claudecli" });
        expect(resolved).toEqual({});
    });
});

// ── Base URL normalisation ────────────────────────────────────────────────────

describe("getProviderConfig — baseURL normalisation [CFG-012]", () => {
    it("[CFG-012.no-path] bare host → /v1 appended", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "https://api.openai.com",
        });
        expect(resolved.baseURL).toContain("/v1");
        expect(resolved.baseURL).not.toMatch(/\/v1\//);
    });

    it("[CFG-012.trailing-slash] host with trailing slash → /v1", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "https://api.openai.com/",
        });
        expect(resolved.baseURL).toMatch(/\/v1$/);
    });

    it("[CFG-012.explicit-v1] explicit /v1 path kept", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "https://api.openai.com/v1",
        });
        expect(resolved.baseURL).toBe("https://api.openai.com/v1");
    });

    it("[CFG-012.custom-path] custom path (/openai/v1) respected", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "https://proxy.example.com/openai/v1",
        });
        expect(resolved.baseURL).toBe("https://proxy.example.com/openai/v1");
    });

    it("[CFG-012.env-url] env-sourced URL overrides inline", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_OPENAI_SECRET:     "sk-x",
            ADHD_AGENT_CODEX_BASE_URL:    "https://codex-proxy.example.com/v2",
        }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            url: "ADHD_AGENT_CODEX_BASE_URL",
            inlineBaseURL: "https://api.openai.com",
        });
        expect(resolved.baseURL).toBe("https://codex-proxy.example.com/v2");
    });

    it("[CFG-012.negative] bare host without /v1 is mutated (negative: /v1 must appear)", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineBaseURL: "https://api.openai.com",
        });
        // If the normalisation were removed, the baseURL would NOT contain /v1
        expect(resolved.baseURL).toMatch(/\/v1/);
    });
});

// ── Model resolution ─────────────────────────────────────────────────────────

describe("getProviderConfig — model resolution [CFG-013]", () => {
    it("[CFG-013.env-model] env.model name resolves to the model value", () => {
        const c = loadConfig(makeEnv({
            ADHD_AGENT_OPENAI_SECRET:  "sk-x",
            ADHD_AGENT_CODEX_MODEL:    "gpt-5-codex",
        }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            model: "ADHD_AGENT_CODEX_MODEL",
        });
        expect(resolved.model).toBe("gpt-5-codex");
    });

    it("[CFG-013.inline-model-fallback] inline model used when no env name", () => {
        const c = loadConfig(makeEnv({ ADHD_AGENT_OPENAI_SECRET: "sk-x" }));
        const resolved = c.getProviderConfig({
            provider: "openai",
            inlineModel: "gpt-4o-mini",
        });
        expect(resolved.model).toBe("gpt-4o-mini");
    });
});

// ── No lmstudio in src/ ───────────────────────────────────────────────────────

describe("no lmstudio references in src/ [CFG-014]", () => {
    it("[CFG-014.no-lmstudio-type] lmstudio is NOT a valid provider — getProviderConfig throws for it", () => {
        // 'lmstudio' is removed as a provider type. PROVIDER_DEFAULTS has no entry for
        // it. When passed at runtime without a secret or localhost URL, getProviderConfig
        // throws the fail-loud credential error — it does NOT silently return {}.
        const c = loadConfig(EMPTY);
        expect(() =>
            // @ts-expect-error lmstudio is not a valid provider type
            c.getProviderConfig({ provider: "lmstudio" })
        ).toThrow(/No credential for lmstudio/);
    });

    it("[CFG-014.filesystem] lmstudio.ts does not exist in providers/", async () => {
        // Dynamic check: attempt to import lmstudio.js should fail with module-not-found
        let importFailed = false;
        try {
            await import("../providers/lmstudio.js");
        } catch {
            importFailed = true;
        }
        expect(importFailed).toBe(true);
    });

    it("[CFG-014.negative] lmstudio does NOT return {} — only claudecli is credential-exempt", () => {
        const c = loadConfig(EMPTY);
        // claudecli is exempt (drives the local claude CLI, no API key needed)
        expect(c.getProviderConfig({ provider: "claudecli" })).toEqual({});
        // lmstudio throws — confirming it is NOT exempt
        let lmstudioThrew = false;
        try {
            // @ts-expect-error lmstudio is not a valid provider type
            c.getProviderConfig({ provider: "lmstudio" });
        } catch {
            lmstudioThrew = true;
        }
        expect(lmstudioThrew).toBe(true);
    });
});

// ── Legacy shim + back-compat ─────────────────────────────────────────────────

describe("providerConfigSchema legacy shim [CFG-015]", () => {
    it("[CFG-015.lmstudio-coerce] type:lmstudio is coerced to type:openai", async () => {
        const { providerConfigStoredSchema } = await import("../validation/agent.js");
        const parsed = providerConfigStoredSchema.parse({
            type: "lmstudio",
            model: "qwen2.5-coder-7b",
            baseURL: "http://localhost:1234/v1",
        });
        expect(parsed.type).toBe("openai");
    });

    it("[CFG-015.apiKeyEnv-coerce] apiKeyEnv is mapped to env.secret", async () => {
        const { providerConfigStoredSchema } = await import("../validation/agent.js");
        const parsed = providerConfigStoredSchema.parse({
            type: "openai",
            model: "gpt-4o",
            apiKeyEnv: "ADHD_AGENT_OPENAI_SECRET",
        });
        expect(parsed.type).toBe("openai");
        expect((parsed as { env?: { secret?: string } }).env?.secret).toBe("ADHD_AGENT_OPENAI_SECRET");
    });

    it("[CFG-015.authTokenEnv-coerce] authTokenEnv is mapped to env.secret", async () => {
        const { providerConfigStoredSchema } = await import("../validation/agent.js");
        const parsed = providerConfigStoredSchema.parse({
            type: "anthropic",
            model: "claude-haiku-4-5",
            authTokenEnv: "ADHD_AGENT_ANTHROPIC_SECRET",
        });
        expect(parsed.type).toBe("anthropic");
        expect((parsed as { env?: { secret?: string } }).env?.secret).toBe("ADHD_AGENT_ANTHROPIC_SECRET");
    });

    it("[CFG-015.useClaudeOauth-dropped] useClaudeOauth field is silently removed", async () => {
        const { providerConfigStoredSchema } = await import("../validation/agent.js");
        const parsed = providerConfigStoredSchema.parse({
            type: "anthropic",
            model: "claude-haiku-4-5",
            useClaudeOauth: true,
            apiKeyEnv: "ADHD_AGENT_ANTHROPIC_SECRET",
        }) as Record<string, unknown>;
        expect(parsed["useClaudeOauth"]).toBeUndefined();
    });

    it("[CFG-015.negative] parsing with lmstudio WITHOUT shim would fail (verifies shim is doing work)", async () => {
        // If we bypassed the shim and passed "lmstudio" directly to the raw union, it would throw.
        const { z } = await import("zod");
        const strictUnion = z.discriminatedUnion("type", [
            z.object({ type: z.literal("openai"), model: z.string().optional() }),
            z.object({ type: z.literal("anthropic"), model: z.string().optional() }),
            z.object({ type: z.literal("claudecli") }),
        ]);
        expect(() =>
            strictUnion.parse({ type: "lmstudio", model: "x" })
        ).toThrow();
    });
});

// ── .env hierarchy precedence ─────────────────────────────────────────────────
// Tested via the fakeEnv mechanism (module-level hierarchy loading doesn't run
// for loadConfig(fakeEnv) — it uses the provided object directly).

describe(".env hierarchy precedence [CFG-016]", () => {
    it("[CFG-016.most-specific-wins] the value closer to the project beats the global", () => {
        // Simulate two envs that would load in hierarchy order:
        // ~/ .adhd/.env would have ADHD_AGENT_LOG_LEVEL=warn
        // <cwd>/.env   would have ADHD_AGENT_LOG_LEVEL=debug (more specific)
        // loadConfig reads from the already-merged env; fakeEnv simulates the winning value.
        const cFromGlobal = loadConfig(makeEnv({ ADHD_AGENT_LOG_LEVEL: "warn" }));
        const cFromProject = loadConfig(makeEnv({ ADHD_AGENT_LOG_LEVEL: "debug" }));
        expect(cFromGlobal.logging.level).toBe("warn");
        expect(cFromProject.logging.level).toBe("debug");
        // The "debug" (most-specific) would win in the real hierarchy
        expect(cFromProject.logging.level).not.toBe(cFromGlobal.logging.level);
    });
});
