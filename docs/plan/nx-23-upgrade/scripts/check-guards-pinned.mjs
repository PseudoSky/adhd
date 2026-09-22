#!/usr/bin/env node
/**
 * check-guards-pinned.mjs — reference-conformance probe for [ref:pinned-guard-tool-resolution].
 *
 * A guard that relies on ambient PATH resolves green in one shell and 127 in a
 * clean subprocess, so guard pass/fail stops measuring the code and starts
 * measuring the environment. Every guard in this plan must resolve its tool
 * through a repo-local anchor (`./node_modules/.bin/<tool>`) or be a
 * `python3 <script>.py` invocation.
 *
 * Exit 0 ⇔ every guard is pinned. Exit 1 ⇔ at least one guard is ambient.
 */
import fs from "node:fs";

const DAG = "docs/plan/nx-23-upgrade/dag.json";
const dag = JSON.parse(fs.readFileSync(DAG, "utf8"));

const unpinned = [];
for (const [slug, node] of Object.entries(dag.nodes || {})) {
  const g = node && typeof node.guard === "string" ? node.guard : "";
  if (!g.trim()) {
    unpinned.push(`${slug} (no guard)`);
    continue;
  }
  if (g.includes("./node_modules/.bin/")) continue;
  if (/^\s*python3?\s/.test(g)) continue;
  unpinned.push(`${slug} -> ${g.slice(0, 90)}`);
}

if (unpinned.length) {
  console.error(
    `check-guards-pinned: RED — ${unpinned.length} guard(s) rely on ambient PATH:\n` +
      unpinned.map((u) => `  - ${u}`).join("\n"),
  );
  process.exit(1);
}

console.log(`check-guards-pinned: PASS — all ${Object.keys(dag.nodes || {}).length} guards are pinned.`);
process.exit(0);
