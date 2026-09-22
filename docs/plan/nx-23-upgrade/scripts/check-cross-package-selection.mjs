#!/usr/bin/env node
/**
 * check-cross-package-selection.mjs — the consumer-coverage probe (DoD [dod.7]).
 *
 * WHY THIS EXISTS. Measured on the default branch: for a CROSS-package change
 * `vitest related` selected ZERO spec files and exited 0, because at test time a
 * bare `@adhd/<dep>` specifier resolved through the node_modules symlink to the
 * dependency's built output — never its source. The dependent's module graph
 * therefore terminated at the package boundary and the changed source file was
 * invisible to it. That is the silent-pass hazard, and it is exactly the class
 * of bug the commit gate's consumer coverage exists to prevent.
 *
 * THE CONTRACT THIS PROVES. With the test-time source resolution helper in
 * place, changing a source file in a base package must select specs in the
 * packages that depend on it — not just the base package's own specs.
 *
 * `date.ts` is chosen because data-query-engine imports the base package and
 * consumes it; the assertion names that dependent package explicitly, so a run
 * that only re-tests the base package FAILS here.
 *
 * Exit 0 ⇔ at least one dependent package's spec was selected.
 * Exit 1 ⇔ the selection stopped at the package boundary (the measured bug).
 */
import { spawnSync } from "node:child_process";

const BASE_INPUT = "packages/data/data-base-transforms/src/lib/date.ts";
const DEPENDENT_MARKER = "data-query-engine";

const r = spawnSync(
  "pnpm",
  ["run", "test:related", "--", BASE_INPUT],
  { encoding: "utf8", cwd: process.cwd(), shell: false },
);
const out = `${r.stdout || ""}${r.stderr || ""}`;

if (r.error) {
  console.error(
    `check-cross-package-selection: RED — could not run \`pnpm run test:related\` (${r.error.message}).\n` +
      "The opt-in fast path is not wired yet; this criterion is red until the state delivers it.",
  );
  process.exit(1);
}

if (r.status !== 0) {
  console.error(
    `check-cross-package-selection: RED — the fast path exited ${r.status} for a covered input.\n` +
      `input: ${BASE_INPUT}\n--- output ---\n${out}`,
  );
  process.exit(1);
}

if (!out.includes(DEPENDENT_MARKER)) {
  console.error(
    "check-cross-package-selection: RED — the selection stopped at the package boundary.\n" +
      `input: ${BASE_INPUT}\n` +
      `expected a selected spec belonging to \`${DEPENDENT_MARKER}\`; found none.\n` +
      "This is the measured silent-pass hazard: a cross-package change re-tests only\n" +
      "the package it touched, and the dependent's specs never run.\n" +
      `--- output ---\n${out}`,
  );
  process.exit(1);
}

console.log(
  `check-cross-package-selection: PASS — \`${BASE_INPUT}\` selected specs in ` +
    `\`${DEPENDENT_MARKER}\` (consumer coverage preserved across the package boundary).`,
);
process.exit(0);
