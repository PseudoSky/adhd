/**
 * Correction bucket B (37f6c511 RV-B4, RV-B6; 9ae6927d AC1): PriceHistoryStore against a real
 * better-sqlite3 DB built with the REAL migration set. No mocks.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PriceHistoryStore, SUPERSEDED_RUN_ERROR, type INewPriceRow } from "../store/price-history-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const MIGRATIONS = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-store-runtime");

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:05:00.000Z";
const T2 = "2026-10-01T00:20:00.000Z";
const OPTS = { minIntervalMs: 24 * 3_600_000, runningTtlMs: 600_000, force: false, sourceUrl: "https://x" };

function row(modelId: string, input: number | null, output: number | null): INewPriceRow {
    return {
        modelId,
        kind: "model",
        inputPerM: input,
        cacheReadPerM: null,
        cacheWritePerM: null,
        outputPerM: output,
        rawJson: "{}",
        overridesJson: null,
    };
}

describe("PriceHistoryStore correction bucket B (real SQLite)", () => {
    let scratch: string;
    let conn: Database.Database;
    let store: PriceHistoryStore;

    beforeEach(() => {
        mkdirSync(SCRATCH_ROOT, { recursive: true });
        scratch = mkdtempSync(join(SCRATCH_ROOT, "price-fixb-"));
        conn = new Database(join(scratch, "runtime.db"));
        conn.pragma("journal_mode = WAL");
        migrate(drizzle(conn), { migrationsFolder: MIGRATIONS });
        store = new PriceHistoryStore(drizzle(conn) as never);
    });
    afterEach(() => {
        conn.close();
        rmSync(scratch, { recursive: true, force: true });
    });

    it("37f6c511 RV-B4: finishPull on a row already superseded to failed does not change it", () => {
        const first = store.claimPull(T0, OPTS);
        if (!first.claimed) throw new Error("claim");
        // A newer claim past the TTL supersedes the crashed run.
        const second = store.claimPull(T2, OPTS);
        expect(second.claimed).toBe(true);
        const before = conn.prepare("select * from price_pull_ledger where id = ?").get(first.ledgerId);
        expect(before).toMatchObject({ status: "failed", error: SUPERSEDED_RUN_ERROR });

        const closed = store.finishPull(first.ledgerId, { status: "ok", finishedAt: T2, modelsSeen: 99 });

        expect(closed).toBe(false);
        expect(conn.prepare("select * from price_pull_ledger where id = ?").get(first.ledgerId)).toEqual(before);
    });

    it("37f6c511 RV-B4: finishPull on a running row closes it once and reports true", () => {
        const c = store.claimPull(T0, OPTS);
        if (!c.claimed) throw new Error("claim");
        expect(store.finishPull(c.ledgerId, { status: "ok", finishedAt: T1 })).toBe(true);
        expect(store.finishPull(c.ledgerId, { status: "failed", finishedAt: T2 })).toBe(false);
        expect(store.lastLedger(T2).lastOk?.id).toBe(c.ledgerId);
    });

    it.each([
        ["0 -> 0.5", 0, 0.5],
        ["0.5 -> 0", 0.5, 0],
    ])("37f6c511 RV-B6: a price move %s is applied with a warning, not held", (_label, from, to) => {
        const a = store.claimPull(T0, OPTS);
        if (!a.claimed) throw new Error("claim");
        store.applyObservation(a.ledgerId, [row("v/free", from, from)], T0, new Set());
        store.finishPull(a.ledgerId, { status: "ok", finishedAt: T0 });

        const b = store.claimPull(T2, { ...OPTS, force: true });
        if (!b.claimed) throw new Error("claim");
        const res = store.applyObservation(b.ledgerId, [row("v/free", to, to)], T2, new Set());

        expect(res.changedIds).toHaveLength(1);
        expect(res.anomalies.filter((x) => x.severity === "hold")).toHaveLength(0);
        expect(res.anomalies.filter((x) => x.severity === "warn").map((x) => x.field)).toEqual(["inputPerM", "outputPerM"]);
        expect(store.latest("v/free")?.inputPerM).toBe(to);
    });

    it("37f6c511 RV-B6: 0 -> 0 is unchanged and raises no anomaly", () => {
        const a = store.claimPull(T0, OPTS);
        if (!a.claimed) throw new Error("claim");
        store.applyObservation(a.ledgerId, [row("v/free", 0, 0)], T0, new Set());
        const res = store.applyObservation(a.ledgerId, [row("v/free", 0, 0)], T1, new Set());
        expect(res.unchangedCount).toBe(1);
        expect(res.anomalies).toEqual([]);
    });

    it("37f6c511 RV-B6: the >= 20x hold is unchanged", () => {
        const a = store.claimPull(T0, OPTS);
        if (!a.claimed) throw new Error("claim");
        store.applyObservation(a.ledgerId, [row("v/m", 1, 1)], T0, new Set());
        const res = store.applyObservation(a.ledgerId, [row("v/m", 25, 1)], T1, new Set());
        expect(res.changedIds).toHaveLength(0);
        expect(res.anomalies.some((x) => x.severity === "hold")).toBe(true);
        expect(store.latest("v/m")?.inputPerM).toBe(1);
    });

    it("9ae6927d AC1: a forced claim within forcedMinIntervalMs of ANY prior attempt is refused (forced_too_soon), even a failed one", () => {
        const a = store.claimPull(T0, OPTS);
        if (!a.claimed) throw new Error("claim");
        store.finishPull(a.ledgerId, { status: "failed", finishedAt: T0, error: "boom" });

        const forced = { ...OPTS, force: true, forcedMinIntervalMs: 600_000 };
        expect(store.claimPull(T1, forced)).toEqual({ claimed: false, reason: "forced_too_soon" });
        expect(store.claimPull(T2, forced).claimed).toBe(true);
    });

    it("9ae6927d AC1: the floor is enforced inside the claim, so a second connection to the same DB cannot bypass it", () => {
        const second = new Database(join(scratch, "runtime.db"));
        try {
            const other = new PriceHistoryStore(drizzle(second) as never);
            const forced = { ...OPTS, force: true, forcedMinIntervalMs: 600_000 };
            expect(store.claimPull(T0, forced).claimed).toBe(true);
            // First pull is still running on connection A; connection B is blocked either way, and once it
            // finishes (ok) B is still held off by the floor rather than by the running gate.
            const a = store.lastLedger(T0);
            expect(a).toBeDefined();
            const running = conn.prepare("select id from price_pull_ledger where status='running'").get() as { id: string };
            store.finishPull(running.id, { status: "ok", finishedAt: T0 });
            expect(other.claimPull(T1, forced)).toEqual({ claimed: false, reason: "forced_too_soon" });
        } finally {
            second.close();
        }
    });
});
