/**
 * Backlog 76950870 — an explicit process-level env var must never be silently
 * overridden by a `.env` file. Drives the REAL `loadEnvHierarchy()` and real
 * `dotenv` against real files under this project's `tmp/` (AGENTS.md §10).
 * `HOME` is redirected so `~/.adhd/.env` can never read the developer's real
 * file; `process.env` is snapshotted/restored per test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEnvHierarchy } from "../utils/load-env";

const KEYS = [
    "ADHD_AGENT_DATABASE_PATH",
    "ADHD_AGENT_TEST_ONLY_FILE",
    "ADHD_AGENT_TEST_LAYER",
    "ADHD_AGENT_ANTHROPIC_SECRET",
];

let root: string;
let home: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;

function write(file: string, body: string): void {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
}

beforeEach(() => {
    savedEnv = { ...process.env };
    for (const k of KEYS) delete process.env[k];
    const base = join(__dirname, "..", "..", "tmp");
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "load-env-"));
    home = join(root, "home");
    cwd = join(root, "cwd");
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    process.env.HOME = home;
});

afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
});

describe("loadEnvHierarchy precedence", () => {
    it("76950870 AC1: process env beats cwd .env, cwd/.adhd/.env and ~/.adhd/.env", () => {
        process.env.ADHD_AGENT_DATABASE_PATH = "/prod/agents.db";
        write(join(cwd, ".env"), "ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db\n");
        write(join(cwd, ".adhd", ".env"), "ADHD_AGENT_DATABASE_PATH=project.db\n");
        write(join(home, ".adhd", ".env"), "ADHD_AGENT_DATABASE_PATH=home.db\n");

        loadEnvHierarchy(cwd);

        expect(process.env.ADHD_AGENT_DATABASE_PATH).toBe("/prod/agents.db");
    });

    it("76950870 AC1: an explicitly empty non-secret process var is still explicit", () => {
        process.env.ADHD_AGENT_DATABASE_PATH = "";
        write(join(cwd, ".env"), "ADHD_AGENT_DATABASE_PATH=from-file.db\n");

        loadEnvHierarchy(cwd);

        expect(process.env.ADHD_AGENT_DATABASE_PATH).toBe("");
    });

    it("76950870 AC2: absent from process env, cwd .env still applies and beats lower file layers", () => {
        write(join(home, ".adhd", ".env"), "ADHD_AGENT_TEST_LAYER=home\nADHD_AGENT_TEST_ONLY_FILE=home-only\n");
        write(join(cwd, ".adhd", ".env"), "ADHD_AGENT_TEST_LAYER=project\n");
        write(join(cwd, ".env"), "ADHD_AGENT_TEST_LAYER=cwd\nADHD_AGENT_DATABASE_PATH=cwd.db\n");

        loadEnvHierarchy(cwd);

        expect(process.env.ADHD_AGENT_TEST_LAYER).toBe("cwd");
        expect(process.env.ADHD_AGENT_DATABASE_PATH).toBe("cwd.db");
        expect(process.env.ADHD_AGENT_TEST_ONLY_FILE).toBe("home-only");
    });

    it("76950870 AC2: cwd/.adhd/.env beats ~/.adhd/.env when no cwd .env defines the key", () => {
        write(join(home, ".adhd", ".env"), "ADHD_AGENT_TEST_LAYER=home\n");
        write(join(cwd, ".adhd", ".env"), "ADHD_AGENT_TEST_LAYER=project\n");

        loadEnvHierarchy(cwd);

        expect(process.env.ADHD_AGENT_TEST_LAYER).toBe("project");
    });

    it("76950870 AC2: an empty forwarded *_SECRET is treated as unset so a file can fill it", () => {
        process.env.ADHD_AGENT_ANTHROPIC_SECRET = "";
        write(join(home, ".adhd", ".env"), "ADHD_AGENT_ANTHROPIC_SECRET=placeholder-from-file\n");

        loadEnvHierarchy(cwd);

        expect(process.env.ADHD_AGENT_ANTHROPIC_SECRET).toBe("placeholder-from-file");
    });
});
