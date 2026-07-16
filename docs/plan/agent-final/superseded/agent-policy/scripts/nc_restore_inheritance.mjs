/**
 * nc_restore_inheritance.mjs — Restores agent-policy-store.ts after nc_break.
 *
 * Usage (from repo root):
 *   node docs/plan/agent-policy/scripts/nc_restore_inheritance.mjs
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(
    __dirname,
    "../../../../packages/ai/agent-policy/src/store/agent-policy-store.ts"
);
const BACKUP_PATH = STORE_PATH + ".nc_orig";

if (!existsSync(BACKUP_PATH)) {
    console.log("[nc_restore] No backup found — nothing to restore.");
    process.exit(0);
}

const original = readFileSync(BACKUP_PATH, "utf8");
writeFileSync(STORE_PATH, original, "utf8");
unlinkSync(BACKUP_PATH);

console.log("[nc_restore] Restored agent-policy-store.ts from backup.");
console.log("[nc_restore] Run the guard — inheritance.test.ts MUST go GREEN.");
