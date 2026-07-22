#!/usr/bin/env node
/**
 * nc_break_binding.mjs — negative-control mutation for model-platform-bindings.4
 *
 * Drops the `platform` filter from `resolveModelId` in model-store.ts so that
 * the method returns the FIRST binding row regardless of platform — collapsing
 * both platform-specific ids into a single result.
 *
 * After this mutation the binding-store tests that assert cross-platform isolation
 * (e.g. returning the wrong platform's model id) should go RED.
 *
 * Exit 0 = mutation applied; non-zero = failed to apply.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const targetFile = path.join(repoRoot, "packages/ai/agent-provider/src/store/model-store.ts");

const original = fs.readFileSync(targetFile, "utf8");

// Replace the two-condition WHERE (modelId AND platform) with just modelId.
// The exact pattern to find:
//   .where(
//       and(
//           eq(modelPlatformBindings.modelId, canonicalId),
//           eq(modelPlatformBindings.platform, platform)
//       )
//   )
const mutated = original.replace(
  /\.where\(\s*and\(\s*eq\(modelPlatformBindings\.modelId,\s*canonicalId\),\s*eq\(modelPlatformBindings\.platform,\s*platform\)\s*\)\s*\)/,
  ".where(eq(modelPlatformBindings.modelId, canonicalId))"
);

if (mutated === original) {
  process.stderr.write("nc_break_binding: could not find the two-condition WHERE clause to remove\n");
  process.exit(1);
}

fs.writeFileSync(targetFile, mutated, "utf8");
process.stdout.write("nc_break_binding: removed platform filter from resolveModelId\n");
process.exit(0);
