/**
 * b726a987: the 1-hour cache-write tier (`input_cache_write_1h`, kept verbatim in `raw_json`)
 * is exposed on the as-of price record, so the cost path can price 1h cache writes. Real
 * migrations, real SQLite, no mocks.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PriceHistoryStore, createPriceSource, type INewPriceRow } from "../store/price-history-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const MIGRATIONS = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-store-runtime");
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

function haiku(oneHourPerToken: string | undefined): INewPriceRow {
    return {
        modelId: "anthropic/claude-haiku-4.5",
        kind: "model",
        inputPerM: 1,
        cacheReadPerM: 0.1,
        cacheWritePerM: 1.25,
        outputPerM: 5,
        rawJson: JSON.stringify({
            prompt: "0.000001",
            completion: "0.000005",
            input_cache_write: "0.00000125",
            ...(oneHourPerToken === undefined ? {} : { input_cache_write_1h: oneHourPerToken }),
        }),
        overridesJson: null,
    };
}

describe("PriceHistoryStore 1h cache-write tier", () => {
    let scratch: string;
    let conn: Database.Database;
    let store: PriceHistoryStore;

    beforeEach(() => {
        mkdirSync(SCRATCH_ROOT, { recursive: true });
        scratch = mkdtempSync(join(SCRATCH_ROOT, "price-1h-"));
        conn = new Database(join(scratch, "runtime.db"));
        conn.pragma("journal_mode = WAL");
        migrate(drizzle(conn), { migrationsFolder: MIGRATIONS });
        store = new PriceHistoryStore(drizzle(conn) as never);
    });
    afterEach(() => {
        conn.close();
        rmSync(scratch, { recursive: true, force: true });
    });

    it("b726a987 AC1: priceAt exposes input_cache_write_1h from raw_json as $/M (2.0 for haiku-4.5)", () => {
        store.seedBundled([haiku("0.000002")], T0);
        const rec = createPriceSource(drizzle(conn) as never).priceAt("anthropic/claude-haiku-4.5", T1);
        expect(rec?.cacheWrite1hPerM).toBe(2);
        expect(rec?.cacheWritePerM).toBe(1.25);
    });

    it("b726a987 AC4: a row with no 1h tier in raw_json reads cacheWrite1hPerM null (cost path falls back to the 5m rate)", () => {
        store.seedBundled([haiku(undefined)], T0);
        expect(store.priceAt("anthropic/claude-haiku-4.5", T1)?.cacheWrite1hPerM).toBeNull();
    });

    it("b726a987 AC4: a malformed raw_json 1h value reads null, never NaN or a throw", () => {
        store.seedBundled([haiku("not-a-number")], T0);
        expect(store.priceAt("anthropic/claude-haiku-4.5", T1)?.cacheWrite1hPerM).toBeNull();
    });

    it("b726a987 AC1: a feed update that changes ONLY the 1h tier appends a new row (not deduped as unchanged)", () => {
        const claimed = store.claimPull(T0, { minIntervalMs: 24 * 3_600_000, runningTtlMs: 600_000, force: true, sourceUrl: "https://openrouter.ai/api/v1/models" });
        if (!claimed.claimed) throw new Error("expected claim");
        store.applyObservation(claimed.ledgerId, [haiku("0.000002")], T0, new Set());
        const same = store.applyObservation(claimed.ledgerId, [haiku("0.000002")], T1, new Set());
        expect(same.unchangedCount).toBe(1);
        const changed = store.applyObservation(claimed.ledgerId, [haiku("0.000003")], "2026-10-03T00:00:00.000Z", new Set());
        expect(changed.changedIds).toHaveLength(1);
        expect(store.latest("anthropic/claude-haiku-4.5")?.cacheWrite1hPerM).toBe(3);
    });
});
