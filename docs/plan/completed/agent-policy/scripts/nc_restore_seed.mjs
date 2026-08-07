/**
 * nc_restore_seed.mjs — restore the idempotent seeder after nc_break_seed
 *
 * Re-applies `.onConflictDoNothing()` to every `db.insert(...).values(...).run()`
 * call in seed/index.ts so the file returns to its correct idempotent form.
 *
 * Precondition: nc_break_seed.mjs was run first.
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

// Re-insert .onConflictDoNothing() before each .run() that belongs to an
// insert chain (i.e. follows .values({...})).  We locate the broken pattern:
// the closing `.run()` on an insert that no longer has .onConflictDoNothing().
const restored = original.replace(
    /(db\.insert\([^)]+\)\s*\n\s*\.values\([^)]+\)\s*\n(\s*))\.run\(\)/gs,
    "$1.onConflictDoNothing()\n$2.run()"
);

if (restored === original) {
    console.error("ERROR: no plain .run() calls found to restore — already restored or pattern changed.");
    process.exit(1);
}

fs.writeFileSync(SEED_INDEX, restored, "utf8");
console.log("nc_restore_seed: re-applied .onConflictDoNothing() to seed/index.ts");
console.log("Run tests now — the idempotency test MUST pass.");
