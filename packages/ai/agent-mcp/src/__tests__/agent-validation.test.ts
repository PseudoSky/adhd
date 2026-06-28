/**
 * agent-validation.test.ts — regression tests for the JSON-Schema / stored-schema split
 * and the env-name guard introduced to fix:
 *
 *   - MCP tools/list crash: "Transforms cannot be represented in JSON Schema"
 *     (transform-free providerConfigSchema vs. stored providerConfigStoredSchema)
 *   - DEBT-014: env-name guard was running on the read path (broke legacy rows and
 *     agent_delete), now confined to create/update INPUT schemas only.
 *   - BUG (envNameGuard path): ctx.addIssue path was hard-coded to ["provider", "env",
 *     field] for both create and update; for agentUpdateInputSchema the correct path is
 *     ["patch", "provider", "env", field].
 *
 * Test keys:
 *   [AVT-001] JSON-Schema regression guard — transforms make z.toJSONSchema throw
 *   [AVT-002] Read-path back-compat (DEBT-014 + legacy shim)
 *   [AVT-003] Input guard — agentCreate + agentUpdate; error path correctness
 *   [AVT-004] claudecli guard exemption
 *   [AVT-005] Env-sourced URL normalization (env-name pointer → /v1 appended)
 *
 * Each behavioral test carries a negative control that goes red if the fix is reverted.
 *
 * Proof of negative control for the path-bug fix (AVT-003.update-error-path):
 *   Before the fix, envNameGuard used path: ["provider", "env", field] for BOTH schemas.
 *   The test asserts path === ["patch", "provider", "env", "secret"]. With the old code
 *   the assertion fails because the path is ["provider", "env", "secret"]. After the fix,
 *   the path is ["patch", "provider", "env", "secret"] and the test passes.
 *   To verify manually: revert the agentUpdateInputSchema superRefine call to
 *   `envNameGuard(val.patch.provider, ctx)` (no providerPath arg), run this file,
 *   AVT-003.update-error-path goes red. Restore the arg to ["patch", "provider"] and
 *   it goes green again.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
    agentCreateInputSchema,
    agentUpdateInputSchema,
    agentDefinitionSchema,
    agentDefinitionStoredSchema,
    providerConfigSchema,
    providerConfigStoredSchema,
} from "../validation/agent.js";
import { loadConfig } from "../config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimum valid stored-row shape (provider already in new shape, no legacy fields). */
const STORED_NOW = {
    name:        "test-agent",
    version:     1,
    provider:    { type: "openai" as const, model: "gpt-4o", env: { secret: "ADHD_AGENT_OPENAI_SECRET" } },
    mcpServers:  {},
    permissions: {},
    createdAt:   "2024-01-01T00:00:00.000Z",
    updatedAt:   "2024-01-01T00:00:00.000Z",
};

/** Legacy stored-row: type:lmstudio + apiKeyEnv (pre-rename, non-ADHD prefix). */
const STORED_LEGACY = {
    name:        "legacy-agent",
    version:     1,
    provider:    { type: "lmstudio", apiKeyEnv: "OPENAI_API_KEY", model: "qwen2.5" },
    mcpServers:  {},
    permissions: {},
    createdAt:   "2024-01-01T00:00:00.000Z",
    updatedAt:   "2024-01-01T00:00:00.000Z",
};

// ── [AVT-001] JSON-Schema regression guard ───────────────────────────────────
// Verifies that z.toJSONSchema does NOT throw on the MCP-exposed input schemas
// (meaning no transform/preprocess is embedded in them).
// The negative control proves the assertion has teeth: a schema that contains
// a transform DOES throw — so a non-throwing result on agentCreateInputSchema
// is meaningful, not vacuous.

describe("[AVT-001] JSON-Schema regression — agentCreateInputSchema and agentUpdateInputSchema", () => {
    it("[AVT-001.create] z.toJSONSchema(agentCreateInputSchema) does not throw", () => {
        expect(() => z.toJSONSchema(agentCreateInputSchema)).not.toThrow();
    });

    it("[AVT-001.create-provider-field] provider field in JSON Schema is a discriminated union (not degenerate {})", () => {
        const schema = z.toJSONSchema(agentCreateInputSchema) as Record<string, unknown>;
        const props = schema["properties"] as Record<string, unknown> | undefined;
        expect(props).toBeDefined();
        // providerConfigSchema is a discriminatedUnion → serialised as oneOf by Zod v4
        const providerProp = props!["provider"] as Record<string, unknown> | undefined;
        expect(providerProp).toBeDefined();
        // oneOf (or anyOf) must be present — the union has real structure, not {}
        const variants =
            (providerProp!["oneOf"] as unknown[] | undefined) ??
            (providerProp!["anyOf"] as unknown[] | undefined);
        expect(variants).toBeDefined();
        expect(Array.isArray(variants)).toBe(true);
        expect((variants as unknown[]).length).toBeGreaterThanOrEqual(2); // openai, anthropic, claudecli
    });

    it("[AVT-001.update] z.toJSONSchema(agentUpdateInputSchema) does not throw", () => {
        expect(() => z.toJSONSchema(agentUpdateInputSchema)).not.toThrow();
    });

    // ── Negative control ────────────────────────────────────────────────────
    // A schema that embeds a .transform() DOES throw — this proves the preceding
    // assertions are meaningful, not accidental. If z.toJSONSchema were lenient
    // about transforms, AVT-001.create would prove nothing.
    it("[AVT-001.negative] a schema with .transform() THROWS in z.toJSONSchema (proves the guard has teeth)", () => {
        const schemaWithTransform = z.object({
            name: z.string().transform(v => v.toUpperCase()),
        });
        expect(() => z.toJSONSchema(schemaWithTransform)).toThrow();
    });

    // Zod v4 note: z.preprocess does NOT throw in z.toJSONSchema (only .transform() does).
    // The stored schema is kept separate from MCP input schemas for semantic reasons:
    // letting the shim coerce caller inputs (lmstudio→openai, apiKeyEnv→env.secret) would
    // bypass the env-name guard for callers supplying pre-rename field names.
    it("[AVT-001.stored-ok-in-json-schema] providerConfigStoredSchema serialises without throwing (Zod v4 preprocess is safe)", () => {
        // In Zod v4, z.preprocess does NOT throw — it uses the inner schema's JSON representation.
        // The stored schema still must NOT be used as an MCP inputSchema (see note above).
        expect(() => z.toJSONSchema(providerConfigStoredSchema)).not.toThrow();
    });
});

// ── [AVT-002] Read-path back-compat (DEBT-014 + legacy shim) ─────────────────
// Verifies that legacy stored rows (type:lmstudio, non-ADHD env names) parse
// successfully through the stored schema, and that the SAME input is REJECTED
// by the transform-free schemas (agentDefinitionSchema, agentCreateInputSchema).
// This proves that the guard is input-only — legacy rows with pre-rename env-var
// names can still be read back without errors.

describe("[AVT-002] Read-path back-compat — legacy shim + DEBT-014 guard confinement", () => {
    it("[AVT-002.stored-legacy-passes] type:lmstudio + apiKeyEnv:OPENAI_API_KEY parses via agentDefinitionStoredSchema", () => {
        const result = agentDefinitionStoredSchema.safeParse(STORED_LEGACY);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.provider.type).toBe("openai");           // lmstudio coerced
            const env = (result.data.provider as { env?: { secret?: string } }).env;
            expect(env?.secret).toBe("OPENAI_API_KEY");                  // apiKeyEnv mapped
        }
    });

    it("[AVT-002.stored-non-adhd-passes] modern row with non-prefixed env.secret parses on read path", () => {
        // DEBT-014: a row written before the ADHD_AGENT_ prefix was mandated must
        // still parse on agent_read / agent_list / agent_delete (all go through the store).
        const rowWithBareSecret = {
            ...STORED_NOW,
            provider: { type: "openai" as const, env: { secret: "OPENAI_API_KEY" } },
        };
        const result = agentDefinitionStoredSchema.safeParse(rowWithBareSecret);
        expect(result.success).toBe(true);
    });

    // ── Negative control ────────────────────────────────────────────────────
    // The same legacy input MUST be rejected by the transform-free schemas that
    // back the MCP input tools. This proves that leniency is deliberate and
    // confined to the read path — it cannot be exploited via agent_create.
    it("[AVT-002.negative-input-schema] type:lmstudio REJECTED by transform-free agentDefinitionSchema", () => {
        const result = agentDefinitionSchema.safeParse(STORED_LEGACY);
        expect(result.success).toBe(false); // lmstudio not in providerConfigSchema union
    });

    it("[AVT-002.negative-create-schema] type:lmstudio REJECTED by agentCreateInputSchema", () => {
        // omit the stored-only fields so the shape matches what create expects
        const { version: _v, createdAt: _c, updatedAt: _u, ...createInput } = STORED_LEGACY;
        const result = agentCreateInputSchema.safeParse(createInput);
        expect(result.success).toBe(false); // lmstudio still not in union on the input side
    });

    it("[AVT-002.negative-non-adhd-blocked-on-create] non-prefixed env.secret REJECTED by agentCreateInputSchema", () => {
        // A new create with a bare env.secret must be rejected by the input guard,
        // even though reads allow it (DEBT-014). This is the key invariant.
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "openai", env: { secret: "OPENAI_API_KEY" } },
        });
        expect(result.success).toBe(false);
    });
});

// ── [AVT-003] Input guard — agentCreate + agentUpdate ───────────────────────
// Verifies that the ADHD_AGENT_-prefix guard fires on create and update input,
// that prefixed names are accepted, and — critically — that the Zod error path
// is correct for BOTH schemas (the path bug was that update always reported
// ["provider","env",field] instead of ["patch","provider","env",field]).

describe("[AVT-003] Input guard — agentCreateInputSchema", () => {
    it("[AVT-003.create-non-prefix-fails] non-ADHD_AGENT_ env.secret is rejected at create time", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "openai", env: { secret: "OPENAI_API_KEY" } },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const issue = result.error.issues.find(i => i.path.includes("secret"));
            expect(issue).toBeDefined();
        }
    });

    it("[AVT-003.create-prefix-passes] ADHD_AGENT_-prefixed env.secret is accepted at create time", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "openai", env: { secret: "ADHD_AGENT_OPENAI_SECRET" } },
        });
        expect(result.success).toBe(true);
    });

    it("[AVT-003.create-anthropic-non-prefix-fails] guard applies to anthropic provider too", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "anthropic", env: { secret: "ANTHROPIC_API_KEY" } },
        });
        expect(result.success).toBe(false);
    });

    it("[AVT-003.create-anthropic-prefix-passes] ADHD_AGENT_-prefixed anthropic env.secret accepted", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "anthropic", env: { secret: "ADHD_AGENT_ANTHROPIC_SECRET" } },
        });
        expect(result.success).toBe(true);
    });

    // Error path correctness for create: path must start with "provider"
    it("[AVT-003.create-error-path] error path for rejected env.secret is [provider, env, secret]", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "openai", env: { secret: "OPENAI_API_KEY" } },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const issue = result.error.issues.find(i =>
                i.path[0] === "provider" && i.path[1] === "env" && i.path[2] === "secret"
            );
            expect(issue).toBeDefined();
        }
    });
});

describe("[AVT-003] Input guard — agentUpdateInputSchema", () => {
    it("[AVT-003.update-non-prefix-fails] non-ADHD_AGENT_ env.secret in patch.provider is rejected", () => {
        const result = agentUpdateInputSchema.safeParse({
            name: "test-agent",
            patch: {
                provider: { type: "openai", env: { secret: "OPENAI_API_KEY" } },
            },
        });
        expect(result.success).toBe(false);
    });

    it("[AVT-003.update-prefix-passes] ADHD_AGENT_-prefixed env.secret in patch.provider is accepted", () => {
        const result = agentUpdateInputSchema.safeParse({
            name: "test-agent",
            patch: {
                provider: { type: "openai", env: { secret: "ADHD_AGENT_OPENAI_SECRET" } },
            },
        });
        expect(result.success).toBe(true);
    });

    // ── Error path correctness — this is the bug fix ──────────────────────
    // BEFORE FIX: envNameGuard used path ["provider","env",field] for both schemas.
    //   For agentUpdateInputSchema (root: {name, patch}) the real field lives at
    //   val.patch.provider.env.{field}, so the error path should be
    //   ["patch","provider","env","secret"] — not ["provider","env","secret"].
    //   With the old code this test goes RED. After the fix it goes GREEN.
    it("[AVT-003.update-error-path] error path for rejected env.secret is [patch, provider, env, secret]", () => {
        const result = agentUpdateInputSchema.safeParse({
            name: "test-agent",
            patch: {
                provider: { type: "openai", env: { secret: "OPENAI_API_KEY" } },
            },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const issue = result.error.issues[0];
            // This assertion fails with the unfixed code (path is ["provider","env","secret"])
            expect(issue.path).toEqual(["patch", "provider", "env", "secret"]);
        }
    });

    // ── Negative control: wrong path would fail ───────────────────────────
    // Symmetrically prove the create path is NOT ["patch", "provider", ...].
    // If the create path were wrong in the other direction, this would fail.
    it("[AVT-003.negative-create-path-is-not-patch] create error path does NOT start with patch", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "openai", env: { secret: "OPENAI_API_KEY" } },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            const issue = result.error.issues[0];
            expect(issue.path[0]).not.toBe("patch");
            expect(issue.path[0]).toBe("provider");
        }
    });
});

// ── [AVT-003] Allowlist via ADHD_AGENT_ENV_ALLOWLIST ─────────────────────────
// The schema guard calls config.isEnvNameAllowed which reads from the frozen
// singleton (constructed from process.env at module load). The full allowlist
// integration is proven at the config level in [CFG-005.allowlist]. Here we
// verify the config API surface directly so there is no ambiguity about what
// the schema guard delegates to.

describe("[AVT-003] Allowlist integration via loadConfig", () => {
    it("[AVT-003.allowlist-extends] ADHD_AGENT_ENV_ALLOWLIST makes non-prefixed names allowed", () => {
        const c = loadConfig({ ADHD_AGENT_ENV_ALLOWLIST: "CUSTOM_SECRET,ANOTHER_KEY" });
        expect(c.isEnvNameAllowed("CUSTOM_SECRET")).toBe(true);
        expect(c.isEnvNameAllowed("ANOTHER_KEY")).toBe(true);
        // A name NOT in the allowlist and without the prefix is still rejected
        expect(c.isEnvNameAllowed("NOT_IN_ALLOWLIST")).toBe(false);
    });

    it("[AVT-003.allowlist-negative] without allowlist, bare names are always rejected", () => {
        const c = loadConfig({});
        expect(c.isEnvNameAllowed("OPENAI_API_KEY")).toBe(false);
        expect(c.isEnvNameAllowed("MY_SECRET")).toBe(false);
    });
});

// ── [AVT-004] claudecli guard exemption ──────────────────────────────────────
// claudecli has no `env` field in its schema. The guard's `!("env" in provider)`
// check must short-circuit so claudecli agents can always be created without
// specifying any env block.

describe("[AVT-004] claudecli guard exemption", () => {
    it("[AVT-004.create-no-env] claudecli agent_create with no env passes the guard", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "cli-agent",
            provider: { type: "claudecli" },
        });
        expect(result.success).toBe(true);
    });

    it("[AVT-004.update-no-env] claudecli patch in agent_update passes the guard", () => {
        const result = agentUpdateInputSchema.safeParse({
            name: "cli-agent",
            patch: { provider: { type: "claudecli", model: "claude-opus-4-8" } },
        });
        expect(result.success).toBe(true);
    });

    // Negative control: a non-claudecli provider without ADHD_AGENT_ prefix
    // must still be rejected — proving the exemption is type-specific.
    it("[AVT-004.negative-openai-still-guarded] openai WITHOUT ADHD_AGENT_ prefix is still rejected", () => {
        const result = agentCreateInputSchema.safeParse({
            name: "test-agent",
            provider: { type: "openai", env: { secret: "MY_PLAIN_SECRET" } },
        });
        expect(result.success).toBe(false);
    });
});

// ── [AVT-005] Env-sourced URL normalization ───────────────────────────────────
// getProviderConfig resolves env.base_url (an env-var NAME) → URL value → then
// calls normalizeBaseUrl. Tests CFG-012 cover inline baseURL normalization; here
// we specifically cover the env-sourced path so an env-var URL with no path also
// gets /v1 appended. This path is exercised when an agent has env.base_url set.

describe("[AVT-005] Env-sourced URL normalization via getProviderConfig", () => {
    it("[AVT-005.env-bare-host] env-var pointing at a bare host → /v1 appended", () => {
        // The env var ADHD_AGENT_MY_BASE_URL holds a bare host — getProviderConfig
        // must normalise it to include /v1 just like an inline URL.
        const c = loadConfig({
            ADHD_AGENT_OPENAI_SECRET:  "sk-x",
            ADHD_AGENT_MY_BASE_URL:    "https://my-server.example.com",
        });
        const resolved = c.getProviderConfig({
            provider: "openai",
            url: "ADHD_AGENT_MY_BASE_URL",
        });
        expect(resolved.baseURL).toMatch(/\/v1$/);
        expect(resolved.baseURL).not.toMatch(/\/v1\//);
    });

    it("[AVT-005.env-trailing-slash] env-var URL with trailing slash → /v1 (no double slash)", () => {
        const c = loadConfig({
            ADHD_AGENT_OPENAI_SECRET: "sk-x",
            ADHD_AGENT_MY_URL:        "https://my-server.example.com/",
        });
        const resolved = c.getProviderConfig({
            provider: "openai",
            url: "ADHD_AGENT_MY_URL",
        });
        expect(resolved.baseURL).toMatch(/\/v1$/);
        expect(resolved.baseURL).not.toContain("//v1");
    });

    it("[AVT-005.env-explicit-path] env-var URL with explicit path is not mutated", () => {
        const c = loadConfig({
            ADHD_AGENT_OPENAI_SECRET: "sk-x",
            ADHD_AGENT_MY_URL:        "https://proxy.example.com/openai/v1",
        });
        const resolved = c.getProviderConfig({
            provider: "openai",
            url: "ADHD_AGENT_MY_URL",
        });
        expect(resolved.baseURL).toBe("https://proxy.example.com/openai/v1");
    });

    // Negative control: without the normalisation in getProviderConfig, a bare
    // env-sourced URL would be returned as-is (no /v1). If normalizeBaseUrl were
    // removed, this test would fail because the URL would not end with /v1.
    it("[AVT-005.negative] bare env URL without normalisation would NOT have /v1 (proves normalisation does work)", () => {
        const c = loadConfig({
            ADHD_AGENT_OPENAI_SECRET: "sk-x",
            ADHD_AGENT_RAW_URL:       "https://raw-server.example.com",
        });
        const resolved = c.getProviderConfig({
            provider: "openai",
            url: "ADHD_AGENT_RAW_URL",
        });
        // The raw URL has no /v1 — if normalisation were absent, this would fail
        const rawHasPath = new URL("https://raw-server.example.com").pathname !== "/";
        expect(rawHasPath).toBe(false); // confirms the raw URL truly has no path
        // But after normalisation, /v1 IS present
        expect(resolved.baseURL).toContain("/v1");
    });
});
