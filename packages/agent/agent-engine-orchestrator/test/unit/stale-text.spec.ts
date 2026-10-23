/**
 * a2a9c6db AC3 / AC4: the dead module and the stale claims stay gone.
 *
 * `engine/denial-message.ts` was imported by no non-test module and its header claimed "adds no default
 * allowlist"; it was deleted with its test. The `shell-exit-status.ts` header said the engine does not depend
 * on native-tooling while `package.json` and `native-tool-guidance.ts` say it does; the CHANGELOG Unreleased
 * block said both "validation-only, no behaviour change" and "sent verbatim" for `thinking`, and both
 * "omits queueWaitMs / sessionMs" and "carries" them for `task:startup`. These read the real files.
 *
 * guards: the deleted dead module engine/denial-message.ts (or its test) comes back, or a source header or the CHANGELOG again claims 'adds no default allowlist', 'does not depend on native-tooling', or contradicts itself on thinking and queueWaitMs/sessionMs.
 * tier: S
 * cites: a2a9c6db AC3, a2a9c6db AC4 (cited in the test titles).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(pkgRoot, rel), "utf8");

describe("a2a9c6db AC3: engine/denial-message.ts is deleted, not left dead", () => {
  it("a2a9c6db AC3: the module and its test are gone and no source claims 'adds no default allowlist'", () => {
    expect(existsSync(join(pkgRoot, "src/engine/denial-message.ts"))).toBe(false);
    expect(existsSync(join(pkgRoot, "test/unit/denial-message.spec.ts"))).toBe(false);
    expect(read("src/engine/native-tool-guidance.ts")).not.toMatch(/adds no default allowlist/);
    expect(read("src/index.ts")).not.toMatch(/denial-message/);
  });
});

describe("a2a9c6db AC4: stale comments and CHANGELOG contradictions are corrected", () => {
  it("a2a9c6db AC4: shell-exit-status.ts does not claim the engine is independent of native-tooling", () => {
    expect(read("src/engine/shell-exit-status.ts")).not.toMatch(/does not depend on\s+native-tooling/);
    expect(JSON.parse(read("package.json")).dependencies).toHaveProperty("@adhd/agent-core-native-tooling");
    expect(read("src/engine/native-tool-guidance.ts")).toContain("@adhd/agent-core-native-tooling");
  });

  it("a2a9c6db AC4: the Unreleased block makes one claim per fact (thinking is sent; task:startup stamps come from startupStamps)", () => {
    const unreleased = /## Unreleased([\s\S]*?)\n## \d/.exec(read("CHANGELOG.md"))?.[1] ?? "";
    expect(unreleased.length).toBeGreaterThan(0);
    // thinking: sent verbatim (R10 S1 P7), so nothing may still call it validation-only / no behaviour change
    expect(unreleased).toMatch(/sends the configured `thinking` option verbatim/);
    expect(unreleased).not.toMatch(/no behaviour change until the wire segment lands/);
    expect(unreleased).not.toMatch(/Validation and plumbing only: the request body is not changed/);
    // task:startup: the engine reports queueWaitMs / sessionMs only when the dispatching tool stamps them
    expect(unreleased).not.toMatch(/omits `queueWaitMs` \/ `sessionMs` because the engine has no truthful source/);
    expect(unreleased).toMatch(/only when the dispatching tool hands them in through `OrchestratorRunInput\.startupStamps`/);
  });
});
