/**
 * nc_break_inheritance.mjs — Negative-control script for [policy-inheritance.3].
 *
 * Disables the lazy category join in AgentPolicyStore.resolveForAgent by
 * replacing the method body with a stub that delegates to listForAgent (the
 * no-join path).  After this patch, inheritance.test.ts MUST go RED because
 * the inherited rows are never returned and inherited_from is never set.
 *
 * Restore with: node nc_restore_inheritance.mjs
 *
 * Usage (from repo root):
 *   node docs/plan/agent-policy/scripts/nc_break_inheritance.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(
    __dirname,
    "../../../../packages/ai/agent-policy/src/store/agent-policy-store.ts"
);

const ORIGINAL_MARKER = "// [NC-BREAK-INHERITANCE:ORIGINAL]";
const BREAK_MARKER    = "// [NC-BREAK-INHERITANCE:BROKEN]";

const content = readFileSync(STORE_PATH, "utf8");

if (content.includes(BREAK_MARKER)) {
    console.log("[nc_break] Already broken — skipping.");
    process.exit(0);
}

// Replace the resolveForAgent implementation with a no-op stub that calls
// listForAgent (no category join) — this is the "broken" path.
const RESOLVE_REGEX =
    /(resolveForAgent\(agentSlug: string\): AgentPolicyRow\[] \{)[\s\S]*?^    \}/m;

const BROKEN_BODY = `resolveForAgent(agentSlug: string): AgentPolicyRow[] { ${BREAK_MARKER}
        // NC-BREAK: category join intentionally omitted — test must go RED
        return this.listForAgent(agentSlug);
    }`;

const patched = content.replace(RESOLVE_REGEX, BROKEN_BODY);

if (patched === content) {
    console.error("[nc_break] ERROR: could not locate resolveForAgent body to patch.");
    process.exit(1);
}

// Save the original for restore
writeFileSync(STORE_PATH + ".nc_orig", content, "utf8");
writeFileSync(STORE_PATH, patched, "utf8");

console.log("[nc_break] Patched agent-policy-store.ts — resolveForAgent now delegates to listForAgent (no join).");
console.log("[nc_break] Run the guard — inheritance.test.ts MUST go RED.");
