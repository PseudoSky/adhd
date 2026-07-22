#!/usr/bin/env node
/**
 * nc_break_enforcement.mjs — negative-control: replace the throw in
 * RatePolicyPlugin.enforce() with a no-op return so the over-limit call passes.
 *
 * After running this script, the enforcement-plugin guard test MUST go RED
 * (the "[enforcement-plugin.3] rate policy throws…" assertion will fail because
 * hooks.enforce() resolves instead of rejects).
 *
 * Run nc_restore_enforcement.mjs to revert.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.resolve(
    __dirname,
    "../../../../packages/ai/agent-policy/src/plugin/index.ts"
);

const original = fs.readFileSync(pluginPath, "utf8");

// Replace the throw with a return (no-op) — the enforcement handler becomes harmless
const broken = original.replace(
    /const violation = evaluateRatePolicy\(rules, acc\.modelCalls\);\s+if \(violation !== null\) throw violation;/,
    "const violation = evaluateRatePolicy(rules, acc.modelCalls);\n        if (violation !== null) return; // NC: throw replaced with no-op"
);

if (broken === original) {
    console.error("nc_break_enforcement: pattern not found — check plugin source");
    process.exit(1);
}

fs.writeFileSync(pluginPath, broken, "utf8");
console.log("nc_break_enforcement: throw replaced with no-op return in", pluginPath);
console.log("Run the guard test — it MUST go RED now:");
console.log(
    "  npx nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts"
);
