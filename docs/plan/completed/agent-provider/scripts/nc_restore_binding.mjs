#!/usr/bin/env node
/**
 * nc_restore_binding.mjs — negative-control restore for model-platform-bindings.4
 *
 * Restores model-store.ts from git after the nc_break_binding.mjs mutation.
 * Always exits 0 — restore must never block the audit runner's finally path.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const targetFile = "packages/ai/agent-provider/src/store/model-store.ts";

const r = spawnSync(
  "git",
  ["checkout", "--", targetFile],
  { cwd: repoRoot, encoding: "utf8" }
);

if (r.status !== 0) {
  process.stderr.write(`nc_restore_binding: git checkout failed (exit ${r.status})\n`);
  process.stderr.write(r.stderr || "");
  process.exit(0);
}

process.stdout.write("nc_restore_binding: restored model-store.ts from git\n");
process.exit(0);
