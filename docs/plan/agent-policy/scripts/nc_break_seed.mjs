/**
 * nc_break_seed.mjs — negative-control: break the idempotent seeder
 *
 * Replaces `onConflictDoNothing()` calls in seed/index.ts with plain `.run()`
 * so that the second seed() call throws a UNIQUE constraint violation.
 * The roundtrip idempotency test MUST go red after this patch.
 *
 * Restore with: node docs/plan/agent-policy/scripts/nc_restore_seed.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_INDEX = path.resolve(
    __dirname,
    "../../../../packages/ai/agent-policy/src/seed/index.ts"
);

const original = fs.readFileSync(SEED_INDEX, "utf8");

// Replace idempotent inserts with plain inserts (no conflict handling).
const broken = original
    .replace(/\.onConflictDoNothing\(\)\s*\n(\s*)\.run\(\)/g, "\n$1.run()");

if (broken === original) {
    console.error("ERROR: no onConflictDoNothing() calls found — seed may already be broken or pattern changed.");
    process.exit(1);
}

fs.writeFileSync(SEED_INDEX, broken, "utf8");
console.log("nc_break_seed: removed .onConflictDoNothing() from seed/index.ts");
console.log("Run tests now — the idempotency test MUST fail.");
