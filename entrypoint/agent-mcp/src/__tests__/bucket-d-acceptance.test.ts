/**
 * Bucket D — acceptance criteria as executable tests.
 *
 * User constraint: every acceptance criterion of every bucket item must have its
 * own test that FAILS if the fix/artifact were reverted. These are the AC tests
 * for the document/dossier and workflow items whose deliverable is a repo
 * artifact (not runtime code):
 *
 *   - cb2cec85  docs/dispatcher/DISPATCHER-RECONCILIATION.md
 *   - d78c8b1a  docs/agent-mcp/APIGEN-MULTISURFACE-DESIGN.md
 *   - 4bbe63ed  .claude/workflows/run-registry-agent.{js,md}   (AC1 + AC5)
 *
 * Hosting note: the repo has no repo-conformance nx project, and the bucket's
 * gate (`nx affected -t test --base=<base>`) runs the agent-mcp project (which
 * this bucket's code change makes affected). agent-mcp is also a subject of every
 * one of these items (the runtime behind the workflow; the migration target; one
 * of the three dispatchers), so its suite is the correct home at this time.
 * Deleting any artifact or removing a required section turns these red.
 *
 * Pure content assertions — no network, no DB, no temp files; nothing to clean up.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// __tests__ -> src -> agent-mcp -> entrypoint -> repo root.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("cb2cec85 AC: dispatcher reconciliation dossier", () => {
    const DOC = "docs/dispatcher/DISPATCHER-RECONCILIATION.md";

    it("the dossier exists", () => {
        expect(existsSync(path.join(REPO_ROOT, DOC)), `${DOC} must exist`).toBe(true);
    });

    it("AC1: covers what EACH of the three dispatchers does", () => {
        const doc = read(DOC);
        for (const subject of ["dispatch-cli", "backlog", "agent-mcp"]) {
            expect(doc, `must name the ${subject} concept`).toContain(subject);
        }
        // each gets a role statement, not just a mention
        expect(doc).toMatch(/plan-level DAG/i);
        expect(doc).toMatch(/issue|lifecycle/i);
        expect(doc).toMatch(/agent runtime/i);
    });

    it("AC2: states where they OVERLAP", () => {
        expect(read(DOC)).toMatch(/where they overlap/i);
    });

    it("AC3: states where they are intentionally DIFFERENT", () => {
        expect(read(DOC)).toMatch(/intentionally\*?\*? different|intentionally different/i);
    });

    it("AC4: states how they interact TODAY (dispatch-cli spawns agent-mcp)", () => {
        const doc = read(DOC);
        expect(doc).toMatch(/interact today/i);
        expect(doc).toContain("AgentMcpRunner");
    });

    it("AC5: states how they COULD interact in the future", () => {
        expect(read(DOC)).toMatch(/could\*?\*? interact in future|interact in future/i);
    });

    it("AC6: states which abstractions are shared vs intentionally separate", () => {
        const doc = read(DOC);
        expect(doc).toMatch(/shared vs intentionally-separate|shared vs intentionally separate|intentionally separate/i);
    });
});

describe("d78c8b1a AC: apigen multi-surface design + decomposition", () => {
    const DOC = "docs/agent-mcp/APIGEN-MULTISURFACE-DESIGN.md";

    it("the design document exists", () => {
        expect(existsSync(path.join(REPO_ROOT, DOC)), `${DOC} must exist`).toBe(true);
    });

    it("AC1: is a design (target architecture / design sections present)", () => {
        const doc = read(DOC);
        expect(doc).toMatch(/# .*DESIGN/i);
        expect(doc).toMatch(/target architecture/i);
    });

    it("AC2: decomposes into independently shippable packets", () => {
        const doc = read(DOC);
        expect(doc).toMatch(/independently shippable/i);
        for (const packet of ["P1", "P2", "P3", "P4"]) {
            expect(doc, `must define packet ${packet}`).toContain(packet);
        }
    });

    it("AC3: says explicitly what we are NOT doing", () => {
        expect(read(DOC)).toMatch(/NOT doing/i);
    });

    it("AC4: resolves the named known differences (stateful / queue / environment)", () => {
        const doc = read(DOC);
        for (const term of ["stateful", "queue", "environment"]) {
            expect(doc.toLowerCase(), `must address the '${term}' difference`).toContain(term);
        }
    });

    it("AC5: states the additive-vs-breaking compatibility stance", () => {
        const doc = read(DOC);
        expect(doc).toMatch(/additive|breaking/i);
    });
});

describe("4bbe63ed AC (first slice AC1 + AC5): registry-driven workflow", () => {
    const SCRIPT = ".claude/workflows/run-registry-agent.js";
    const DOC = ".claude/workflows/run-registry-agent.md";

    it("AC1: the workflow script exists", () => {
        expect(existsSync(path.join(REPO_ROOT, SCRIPT)), `${SCRIPT} must exist`).toBe(true);
    });

    it("AC1: the script takes { agentSlug, taskPayload } and uses mcp__agent-mcp__* tools", () => {
        const src = read(SCRIPT);
        expect(src).toContain("agentSlug");
        expect(src).toContain("taskPayload");
        expect(src).toContain("export const meta");
        expect(src).toContain("mcp__agent-mcp__");
    });

    it("AC1: the script is sandbox-safe (no import statements, no require() calls)", () => {
        const src = read(SCRIPT);
        expect(src, "workflow scripts may not use import statements").not.toMatch(/^import\s+/m);
        expect(src, "workflow scripts may not call require()").not.toMatch(/\brequire\s*\(/);
    });

    it("AC5: the paired .md documents invocation, args, limits and pinned version", () => {
        const md = read(DOC);
        expect(md).toMatch(/invocation/i);
        expect(md).toMatch(/args/i);
        expect(md).toMatch(/limits/i);
        expect(md).toMatch(/pinned claude code/i);
        expect(md).toMatch(/re-verify/i);
    });
});
