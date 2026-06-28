/**
 * db-client-path.test.ts — database path resolution via config (F-P6-11).
 *
 * `resolveDatabasePath` was removed when db/client.ts was refactored to use the
 * config singleton directly. Path behaviour is now driven by `ADHD_AGENT_DATABASE_PATH`
 * and is testable via `loadConfig(fakeEnv)`.
 *
 * Asserts:
 *  [F-P6-11.default-path]      — when ADHD_AGENT_DATABASE_PATH is unset,
 *                                 config.db.path resolves to
 *                                 <homedir>/.adhd/agent-mcp/agents.db.
 *  [F-P6-11.env-override]      — when ADHD_AGENT_DATABASE_PATH is set, that
 *                                 value is used verbatim.
 *  [F-P6-11.contains-segments] — the default path contains the expected path
 *                                 segments (.adhd/agent-mcp/agents.db).
 *  [F-P6-11.old-var-ignored]   — the old env var name `DATABASE_PATH` is NOT
 *                                 picked up (regression guard for the rename).
 *
 * Tests call `loadConfig(fakeEnv)` for isolation — no real process.env mutation.
 */

import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { loadConfig } from "../config.js";

describe("config.db.path [F-P6-11]", () => {
    it("[F-P6-11.default-path] default resolves to <homedir>/.adhd/agent-mcp/agents.db", () => {
        const c = loadConfig({});
        const expected = path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db");
        expect(c.db.path).toBe(expected);
    });

    it("[F-P6-11.env-override] ADHD_AGENT_DATABASE_PATH wins when set", () => {
        const override = "/custom/path/to/my.db";
        const c = loadConfig({ ADHD_AGENT_DATABASE_PATH: override });
        expect(c.db.path).toBe(override);
    });

    it("[F-P6-11.contains-segments] default path contains expected segments", () => {
        const c = loadConfig({});
        expect(c.db.path).toMatch(/\.adhd[/\\]agent-mcp[/\\]agents\.db$/);
    });

    it("[F-P6-11.old-var-ignored] old DATABASE_PATH env var is NOT recognised (rename regression guard)", () => {
        const c = loadConfig({ DATABASE_PATH: "/old/agents.db" });
        // Old name is ignored — config uses the default
        expect(c.db.path).not.toBe("/old/agents.db");
        expect(c.db.path).toBe(path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db"));
    });

    it("[F-P6-11.negative] negative control: when ADHD_AGENT_DATABASE_PATH is set the default is NOT used", () => {
        const override = "/explicit/test.db";
        const c = loadConfig({ ADHD_AGENT_DATABASE_PATH: override });
        const defaultPath = path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db");
        // The override wins — the default path must not appear
        expect(c.db.path).not.toBe(defaultPath);
    });
});
