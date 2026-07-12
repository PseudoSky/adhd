import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertEnvNamesAllowed } from "../validation/agent.js";
import type { EngineConfig } from "../interfaces.js";

/**
 * The published 2.0.1 server rejects non-ADHD_AGENT_-prefixed provider env-var names at
 * agent_create / agent_update time. The engine refactor kept the guard factory but never
 * called it, so bad definitions (e.g. env.secret pointing at AWS_SECRET_ACCESS_KEY) parsed
 * clean and persisted to the DB. `assertEnvNamesAllowed` restores the create-time check.
 * See BUG-ORCH-011.
 */

// Mirrors the real allowlist rule: only ADHD_AGENT_-prefixed names pass by default.
const config = {
    isEnvNameAllowed: (name: string) => name.startsWith("ADHD_AGENT_"),
} as unknown as EngineConfig;

describe("assertEnvNamesAllowed (BUG-ORCH-011)", () => {
    it("rejects a non-prefixed env-var name (the exfiltration-shaped case)", () => {
        expect(() =>
            assertEnvNamesAllowed(
                { type: "openai", env: { secret: "AWS_SECRET_ACCESS_KEY" } } as never,
                config
            )
        ).toThrow(z.ZodError);
    });

    it("names the offending field in the error path", () => {
        try {
            assertEnvNamesAllowed(
                { type: "openai", env: { secret: "AWS_SECRET_ACCESS_KEY" } } as never,
                config
            );
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(z.ZodError);
            expect((err as z.ZodError).issues[0].path).toEqual(["provider", "env", "secret"]);
        }
    });

    it("uses the caller-supplied path root (agent_update nests under patch.provider)", () => {
        try {
            assertEnvNamesAllowed(
                { type: "openai", env: { base_url: "SOME_OTHER_URL" } } as never,
                config,
                ["patch", "provider"]
            );
            throw new Error("should have thrown");
        } catch (err) {
            expect((err as z.ZodError).issues[0].path).toEqual(["patch", "provider", "env", "base_url"]);
        }
    });

    it("accepts ADHD_AGENT_-prefixed names", () => {
        expect(() =>
            assertEnvNamesAllowed(
                {
                    type: "openai",
                    env: { secret: "ADHD_AGENT_DEEPSEEK_SECRET", base_url: "ADHD_AGENT_DEEPSEEK_BASE_URL" },
                } as never,
                config
            )
        ).not.toThrow();
    });

    it("is a no-op when the provider has no env block", () => {
        expect(() =>
            assertEnvNamesAllowed({ type: "anthropic" } as never, config)
        ).not.toThrow();
        expect(() => assertEnvNamesAllowed(undefined, config)).not.toThrow();
    });

    it("reports every offending name, not just the first", () => {
        try {
            assertEnvNamesAllowed(
                { type: "openai", env: { secret: "BAD_SECRET", base_url: "BAD_URL" } } as never,
                config
            );
            throw new Error("should have thrown");
        } catch (err) {
            expect((err as z.ZodError).issues.length).toBe(2);
        }
    });
});
