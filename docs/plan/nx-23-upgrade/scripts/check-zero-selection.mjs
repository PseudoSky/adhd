#!/usr/bin/env node
/**
 * check-zero-selection.mjs — the fail-safe probe (DoD [dod.6]).
 *
 * WHY THIS EXISTS. The measured failure mode of the previous selection attempt
 * was FAIL-OPEN: on a clean tree `vitest --changed` printed "No test files found"
 * and exited 0, so the task reported success having run ZERO tests. A selector
 * that can return green having run nothing is worse than no selector at all.
 *
 * THE CONTRACT THIS PROVES. `pnpm run test:related -- <paths...>` must exit
 * NON-ZERO and say so when the selection is empty. This script drives that real
 * command with an input no spec can cover and asserts the failure is loud.
 *
 * Deliberately uses a real repo file that no test covers (a package README)
 * rather than a synthetic path, so the probe exercises the same code path a
 * developer hits when they change something untested.
 *
 * Exit 0 ⇔ the gate behaved correctly (non-zero + message).
 * Exit 1 ⇔ the gate reported success having selected nothing (fail-open).
 */
import { spawnSync } from "node:child_process";

const NO_COVER_INPUT = "packages/data/data-base-transforms/README.md";

const r = spawnSync(
  "pnpm",
  ["run", "test:related", "--", NO_COVER_INPUT],
  { encoding: "utf8", cwd: process.cwd(), shell: false },
);
const out = `${r.stdout || ""}${r.stderr || ""}`;

if (r.error) {
  console.error(
    `check-zero-selection: RED — could not run \`pnpm run test:related\` (${r.error.message}).\n` +
      "The opt-in fast path is not wired yet; this criterion is red until the state delivers it.",
  );
  process.exit(1);
}

if (r.status === 0) {
  console.error(
    "check-zero-selection: RED — the fast path exited 0 with ZERO tests selected.\n" +
      `input: ${NO_COVER_INPUT}\n` +
      "This is the fail-open hazard: a green gate that ran nothing. " +
      "A zero-selection run MUST exit non-zero.\n" +
      `--- output ---\n${out}`,
  );
  process.exit(1);
}

if (!/no tests selected/i.test(out)) {
  console.error(
    "check-zero-selection: RED — the fast path failed, but not with the required\n" +
      "zero-selection message, so the failure is not attributable to empty selection.\n" +
      `--- output ---\n${out}`,
  );
  process.exit(1);
}

console.log(
  `check-zero-selection: PASS — zero selected on \`${NO_COVER_INPUT}\` exited ${r.status} ` +
    "with a loud message (fail-safe, not fail-open).",
);
process.exit(0);
