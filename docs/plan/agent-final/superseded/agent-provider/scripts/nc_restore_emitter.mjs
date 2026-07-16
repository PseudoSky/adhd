#!/usr/bin/env node
/**
 * nc_restore_emitter.mjs — negative-control restore for runtime-tool-forwarding.4
 *
 * Restores the `server_side` case in emit-tools.ts by checking it out from git.
 * Always exits 0 (restore must not block the audit runner even if the mutate
 * partially failed — the runner's finally block guarantees restore runs).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const targetFile = "packages/ai/agent-provider/src/runtime/emit-tools.ts";

const r = spawnSync(
  "git",
  ["checkout", "--", targetFile],
  { cwd: repoRoot, encoding: "utf8" }
);

if (r.status !== 0) {
  process.stderr.write(`nc_restore_emitter: git checkout failed (exit ${r.status})\n`);
  process.stderr.write(r.stderr || "");
  // Still exit 0 — restore must not block the audit runner's finally path
  process.exit(0);
}

process.stdout.write("nc_restore_emitter: restored emit-tools.ts from git\n");
process.exit(0);
