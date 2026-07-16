#!/usr/bin/env node
/**
 * nc_break_emitter.mjs — negative-control mutation for runtime-tool-forwarding.4
 *
 * Removes the `server_side` case from the switch in emit-tools.ts so that every
 * tool (including an Anthropic web_search server_side binding) is emitted via the
 * custom fall-through path instead of the type-tagged path.
 *
 * After this mutation the emit-tools test suite should go RED because the
 * server-side assertions (`type` present, `input_schema` absent) no longer hold.
 *
 * Exit 0 = mutation applied; non-zero = failed to apply.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const targetFile = path.join(repoRoot, "packages/ai/agent-provider/src/runtime/emit-tools.ts");

const original = fs.readFileSync(targetFile, "utf8");

// Remove the server_side case block from the switch statement.
// The block begins with `        case "server_side": {` and ends with the
// closing `        }` of that case (before `case "unsupported"`).
const mutated = original.replace(
  /\s+case "server_side": \{[\s\S]*?\n        \}\n\n        case "unsupported":/,
  "\n\n        case \"unsupported\":"
);

if (mutated === original) {
  process.stderr.write("nc_break_emitter: could not find server_side case to remove\n");
  process.exit(1);
}

fs.writeFileSync(targetFile, mutated, "utf8");
process.stdout.write("nc_break_emitter: removed server_side case from emit-tools.ts\n");
process.exit(0);
