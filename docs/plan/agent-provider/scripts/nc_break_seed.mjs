#!/usr/bin/env node
/**
 * nc_break_seed.mjs — negative-control mutation for seed-and-roundtrip.4
 *
 * Removes the `.onConflictDoNothing()` guard from seed/providers.ts so that a
 * second seed run attempts a plain INSERT on an already-populated table, causing
 * a UNIQUE constraint violation.
 *
 * After this mutation the roundtrip tests that assert idempotency (double-seed
 * produces identical row counts, no error) should go RED.
 *
 * Exit 0 = mutation applied; non-zero = failed to apply.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const targetFile = path.join(repoRoot, "packages/ai/agent-provider/src/seed/providers.ts");

const original = fs.readFileSync(targetFile, "utf8");

// Remove the idempotency guard:
//   // Idempotency: ignore if the PK already exists.
//   .onConflictDoNothing()
const mutated = original
    .replace(/\s*\/\/ Idempotency: ignore if the PK already exists\.\n\s*\.onConflictDoNothing\(\)/g, "");

if (mutated === original) {
    process.stderr.write("nc_break_seed: could not find .onConflictDoNothing() guard to remove\n");
    process.exit(1);
}

fs.writeFileSync(targetFile, mutated, "utf8");
process.stdout.write("nc_break_seed: removed .onConflictDoNothing() from seed/providers.ts\n");
process.exit(0);
