/**
 * c536ce29 FIX-M2 — the claudecli provider throws without `EngineConfig.wire.tempDir` (no OS-tmpdir
 * fallback). That is only safe if no host path hands the engine a bare `toEngineConfig()`.
 *
 * Every non-test `src/` caller of `toEngineConfig()` is enumerated here. The ONLY permitted bare
 * callers are `assertEnvNamesAllowed(...)` (env-name guard; builds no provider) in `server.ts`, the
 * definition in `config.ts`, and the `engineConfig()` seam in `wire/seams.ts`. Any engine-bound
 * config must come from `engineConfig()`. A new bare caller turns this red.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveLogRoots } from "../config.js";
import { engineConfig } from "../wire/seams.js";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === "__tests__" || n === "node_modules" ? [] : sourceFiles(p);
        return /\.ts$/.test(n) && !/\.(test|e2e)\.ts$/.test(n) ? [p] : [];
    });
}

describe("c536ce29 FIX-M2 every engine-bound config carries the wire seams", () => {
    it("engineConfig() injects wire.tempDir = the namespaced temp root", () => {
        const cfg = engineConfig();
        expect(cfg.wire?.tempDir).toBe(resolveLogRoots().temp);
        expect(typeof cfg.wire?.fetch).toBe("function");
        expect(typeof cfg.wire?.spawn).toBe("function");
    });

    it("the only bare toEngineConfig() callers are the env-name guard in server.ts (and the seam/definition)", () => {
        const bare: Record<string, string[]> = {};
        for (const f of sourceFiles(SRC)) {
            const lines = readFileSync(f, "utf8").split("\n");
            lines.forEach((line, i) => {
                if (/\btoEngineConfig\(\)/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
                    (bare[relative(SRC, f)] ??= []).push(`${i + 1}: ${line.trim()}`);
                }
            });
        }
        const files = Object.keys(bare).sort();
        expect(files).toEqual(["config.ts", "server.ts", "wire/seams.ts"]);
        // server.ts: both are assertEnvNamesAllowed(...) probes, never a config handed to the engine.
        for (const l of bare["server.ts"] ?? []) expect(l).toMatch(/assertEnvNamesAllowed\(/);
        expect(bare["server.ts"]).toHaveLength(2);
        // seams.ts: the single place that spreads it together with the wire seams.
        expect((bare["wire/seams.ts"] ?? []).filter((l) => /wire:\s*getWireSeams\(\)/.test(l))).toHaveLength(1);
    });
});
