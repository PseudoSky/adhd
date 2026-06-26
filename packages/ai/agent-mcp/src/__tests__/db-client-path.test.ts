/**
 * db-client-path.test.ts — pure path-resolution tests for db/client.ts (F-P6-11).
 *
 * Asserts:
 *  [F-P6-11.default-path]   — when DATABASE_PATH is unset, resolveDatabasePath()
 *                             returns <homedir>/.adhd/agent-mcp/agents.db.
 *  [F-P6-11.env-override]   — when DATABASE_PATH is set, that value wins.
 *  [F-P6-11.resolve-abs]    — the returned path is always absolute (path.resolve
 *                             applied even to a relative DATABASE_PATH).
 *
 * These tests never open the real home DB — they call the pure function directly
 * with a mocked homedir (via the HOME env var trick) or explicit env overrides,
 * so no `~/.adhd` directory is ever created.
 */

import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { resolveDatabasePath } from "../db/client.js";

describe("resolveDatabasePath [F-P6-11]", () => {
    let savedDatabasePath: string | undefined;
    let savedHome: string | undefined;

    beforeEach(() => {
        savedDatabasePath = process.env["DATABASE_PATH"];
        savedHome = process.env["HOME"];
        // Ensure DATABASE_PATH is unset so the default branch fires
        delete process.env["DATABASE_PATH"];
    });

    afterEach(() => {
        // Restore env state precisely
        if (savedDatabasePath === undefined) {
            delete process.env["DATABASE_PATH"];
        } else {
            process.env["DATABASE_PATH"] = savedDatabasePath;
        }
        if (savedHome === undefined) {
            delete process.env["HOME"];
        } else {
            process.env["HOME"] = savedHome;
        }
    });

    it("[F-P6-11.default-path] default resolves to <homedir>/.adhd/agent-mcp/agents.db", () => {
        const result = resolveDatabasePath(undefined);
        const expected = path.resolve(
            path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db")
        );
        expect(result).toBe(expected);
    });

    it("[F-P6-11.env-override] DATABASE_PATH env var wins when set", () => {
        const override = "/custom/path/to/my.db";
        const result = resolveDatabasePath(override);
        expect(result).toBe(path.resolve(override));
    });

    it("[F-P6-11.resolve-abs] relative DATABASE_PATH is resolved to absolute", () => {
        const result = resolveDatabasePath("./relative/agents.db");
        expect(path.isAbsolute(result)).toBe(true);
    });

    it("[F-P6-11.default-path-contains-adhd] default path contains expected segments", () => {
        const result = resolveDatabasePath(undefined);
        // Platform-agnostic: check that the path ends with the expected suffix
        expect(result).toMatch(/\.adhd[/\\]agent-mcp[/\\]agents\.db$/);
    });

    it("[F-P6-11.no-env] calling with process.env DATABASE_PATH unset returns home default", () => {
        // Confirm process.env is clear before calling with the default argument
        expect(process.env["DATABASE_PATH"]).toBeUndefined();
        const result = resolveDatabasePath(process.env["DATABASE_PATH"]);
        const expected = path.resolve(
            path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db")
        );
        expect(result).toBe(expected);
    });
});
