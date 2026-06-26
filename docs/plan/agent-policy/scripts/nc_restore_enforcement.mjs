#!/usr/bin/env node
/**
 * nc_restore_enforcement.mjs — restore plugin/index.ts to the original throw
 * after nc_break_enforcement.mjs has been run.
 *
 * After running this script, the enforcement-plugin guard test MUST go GREEN again.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.resolve(
    __dirname,
    "../../../../packages/ai/agent-policy/src/plugin/index.ts"
);

const current = fs.readFileSync(pluginPath, "utf8");

// Restore the real throw from the no-op pattern written by nc_break_enforcement
const restored = current.replace(
    /const violation = evaluateRatePolicy\(rules, acc\.modelCalls\);\s+if \(violation !== null\) return; \/\/ NC: throw replaced with no-op/,
    "const violation = evaluateRatePolicy(rules, acc.modelCalls);\n        if (violation !== null) throw violation;"
);

if (restored === current) {
    // Already clean — check if the original throw is present
    if (current.includes("if (violation !== null) throw violation;")) {
        console.log("nc_restore_enforcement: file already has the real throw — nothing to do.");
        process.exit(0);
    }
    console.error("nc_restore_enforcement: neither broken nor original pattern found — manual review needed");
    process.exit(1);
}

fs.writeFileSync(pluginPath, restored, "utf8");
console.log("nc_restore_enforcement: throw restored in", pluginPath);
console.log("Run the guard test — it MUST go GREEN now:");
console.log(
    "  npx nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts"
);
