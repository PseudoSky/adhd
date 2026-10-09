/**
 * S2 (1f1c8598 / 37f6c511): PriceHistoryStore + createPriceSource against a real
 * better-sqlite3 DB built with the REAL migration set that agent-mcp ships. No mocks.
 * File-DB tests open two independent connections to one WAL file (parallel-process invariant).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    ANOMALY_MAX_INPUT_PER_M,
    PriceHistoryStore,
    createPriceSource,
    type INewPriceRow,
} from "../store/price-history-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const MIGRATIONS = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-store-runtime");

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const URL_ = "https://openrouter.ai/api/v1/models";

/** Narrow a possibly-missing value, failing the test loudly instead of using `!`. */
function must<T>(v: T | null | undefined): T {
    if (v === null || v === undefined) throw new Error("expected a value");
    return v;
}

function row(modelId: string, input: number | null, output: number | null, extra: Partial<INewPriceRow> = {}): INewPriceRow {
    return {
        modelId,
        kind: "model",
        inputPerM: input,
        cacheReadPerM: null,
        cacheWritePerM: null,
        outputPerM: output,
        rawJson: JSON.stringify({ prompt: String(input), completion: String(output) }),
        overridesJson: null,
        ...extra,
    };
}

interface IHandle {
    conn: Database.Database;
    store: PriceHistoryStore;
}

function open(file: string, timeoutMs = 5000): IHandle {
    const conn = new Database(file, { timeout: timeoutMs });
    conn.pragma("journal_mode = WAL");
    return { conn, store: new PriceHistoryStore(drizzle(conn) as never) };
}

describe("PriceHistoryStore (real migrations, real SQLite)", () => {
    let scratch: string;
    let file: string;
    let a: IHandle;
    const extra: Database.Database[] = [];

    beforeEach(() => {
        mkdirSync(SCRATCH_ROOT, { recursive: true });
        scratch = mkdtempSync(join(SCRATCH_ROOT, "price-store-"));
        file = join(scratch, "runtime.db");
        a = open(file);
        migrate(drizzle(a.conn), { migrationsFolder: MIGRATIONS });
    });

    afterEach(() => {
        for (const c of extra.splice(0)) c.close();
        a.conn.close();
        rmSync(scratch, { recursive: true, force: true });
    });

    const openSecond = (timeoutMs?: number): IHandle => {
        const h = open(file, timeoutMs);
        extra.push(h.conn);
        return h;
    };
    const claimOpts = { minIntervalMs: 24 * 3_600_000, runningTtlMs: 600_000, force: false, sourceUrl: URL_ };

    function seedThree(store: PriceHistoryStore): void {
        // Three live observations of one model: T0 (new), T1 (changed), T2 (changed).
        for (const [t, inRate] of [[T0, 1], [T1, 2], [T2, 3]] as const) {
            const { ledgerId } = store.claimPull(t, { ...claimOpts, force: true }) as { ledgerId: string };
            store.applyObservation(ledgerId, [row("Vendor/Model-X", inRate, inRate * 4)], t, new Set());
            store.finishPull(ledgerId, { status: "ok", finishedAt: t });
        }
    }

    /** Boundary scenario that distinguishes the as-of rule from "latest" and from strict "<". */
    function asOfChecks(store: PriceHistoryStore): boolean[] {
        return [
            store.priceAt("vendor/model-x", "2026-10-02T12:00:00.000Z")?.inputPerM === 2, // between observations
            store.priceAt("vendor/model-x", T1)?.inputPerM === 2, // exactly at an observation: inclusive
            store.priceAt("vendor/model-x", "2026-10-02T23:59:59.999Z")?.inputPerM === 2, // just before T2
            store.priceAt("vendor/model-x", "2030-01-01T00:00:00.000Z")?.inputPerM === 3, // far future => latest
        ];
    }

    it("37f6c511 FS3-AC1: priceAt returns the latest row at or before the instant, inclusive of the boundary", () => {
        seedThree(a.store);
        expect(asOfChecks(a.store)).toEqual([true, true, true, true]);
        const atT0 = must(a.store.priceAt("vendor/model-x", T0));
        expect(atT0.inputPerM).toBe(1);
        expect(atT0.beforeFirstObservation).toBeUndefined();
        expect(atT0.source).toBe("openrouter-live");
    });

    it("37f6c511 FS3-AC1: before the first observation returns the earliest row flagged beforeFirstObservation; unknown model is undefined", () => {
        seedThree(a.store);
        const early = must(a.store.priceAt("vendor/model-x", "2020-01-01T00:00:00.000Z"));
        expect(early.inputPerM).toBe(1);
        expect(early.observedAt).toBe(T0);
        expect(early.beforeFirstObservation).toBe(true);
        expect(a.store.priceAt("no/such-model", T1)).toBeUndefined();
        expect(a.store.latest("no/such-model")).toBeUndefined();
    });

    it("37f6c511 FS3-AC1 negative control: a deliberately wrong as-of (latest-wins) turns the scenario red, and the real rule is restored afterwards", () => {
        seedThree(a.store);
        const proto = PriceHistoryStore.prototype;
        const original = proto.priceAt;
        expect(asOfChecks(a.store).every(Boolean)).toBe(true);
        try {
            proto.priceAt = function (this: PriceHistoryStore, modelId: string) {
                return this.latest(modelId); // the bug: ignores the instant
            };
            expect(asOfChecks(a.store).every(Boolean)).toBe(false);
        } finally {
            proto.priceAt = original;
        }
        expect(proto.priceAt).toBe(original);
        expect(asOfChecks(a.store).every(Boolean)).toBe(true);
    });

    it("37f6c511 FS3-AC1: tie on observed_at (different sources) resolves to the newest rowid", () => {
        a.store.seedBundled([row("vendor/tie", 1, 1)], T0);
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        // Same instant, different source: both rows coexist (unique index includes source).
        a.store.applyObservation(ledgerId, [row("vendor/tie", 5, 5)], T0, new Set());
        expect(a.store.history("vendor/tie")).toHaveLength(2);
        expect(a.store.priceAt("vendor/tie", T0)?.inputPerM).toBe(5);
    });

    it("37f6c511 FS3-AC2: the history table is append-only (UPDATE and DELETE are rejected by trigger)", () => {
        seedThree(a.store);
        expect(() => a.conn.prepare("UPDATE model_price_history SET input_per_m = 999").run()).toThrow(/append-only/);
        expect(() => a.conn.prepare("DELETE FROM model_price_history").run()).toThrow(/append-only/);
        expect(a.store.history("vendor/model-x")).toHaveLength(3);
    });

    it("37f6c511 FS3-AC2: the unique (model_id, observed_at, source) index makes re-appending the same observation idempotent", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        const first = a.store.applyObservation(ledgerId, [row("vendor/idem", 1, 2)], T0, new Set());
        expect(first.newIds).toHaveLength(1);
        // Direct duplicate insert at the SQL level is rejected by the index.
        expect(() =>
            a.conn
                .prepare(
                    "INSERT INTO model_price_history (id, model_id, observed_at, source, kind, raw_json) VALUES ('dup', 'vendor/idem', ?, 'openrouter-live', 'model', '{}')"
                )
                .run(T0)
        ).toThrow(/UNIQUE/);
        // A differing price at an already-used instant is skipped with an anomaly, never overwritten.
        const clash = a.store.applyObservation(ledgerId, [row("vendor/idem", 9, 9)], T0, new Set());
        expect(clash.newIds).toEqual([]);
        expect(clash.changedIds).toEqual([]);
        expect(clash.anomalies.map((x) => x.severity)).toEqual(["same_instant"]);
        expect(a.store.history("vendor/idem")).toHaveLength(1);
        expect(a.store.latest("vendor/idem")?.inputPerM).toBe(1);
    });

    it("37f6c511 FS2-AC2: an identical observation appends zero rows and counts everything unchanged", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        const rows = [row("v/a", 1, 2), row("v/b", 3, 4)];
        a.store.applyObservation(ledgerId, rows, T0, new Set());
        const again = a.store.applyObservation(ledgerId, rows, T1, new Set());
        expect(again).toMatchObject({ newIds: [], changedIds: [], unchangedCount: 2, anomalies: [] });
        expect(a.store.history("v/a")).toHaveLength(1);
    });

    it("37f6c511 FS2-AC3: exactly one changed model produces exactly one new row at the injected instant", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        a.store.applyObservation(ledgerId, [row("v/a", 1, 2), row("v/b", 3, 4)], T0, new Set());
        const res = a.store.applyObservation(ledgerId, [row("v/a", 1, 2), row("v/b", 3.5, 4)], T1, new Set());
        expect(res.changedIds).toHaveLength(1);
        expect(res.newIds).toHaveLength(0);
        expect(res.unchangedCount).toBe(1);
        const h = a.store.history("v/b");
        expect(h.map((r) => r.observedAt)).toEqual([T0, T1]);
        expect(h[1].id).toBe(res.changedIds[0]);
        expect(h[1].ledgerId).toBe(ledgerId);
    });

    it("37f6c511 FS2-AC1: ids are lowercased on write and on lookup", () => {
        a.store.seedBundled([row("OpenAI/GPT-X", 1, 2)], T0);
        expect(a.store.priceAt("openai/gpt-x", T0)?.modelId).toBe("openai/gpt-x");
        expect(a.store.priceAt("OPENAI/Gpt-X", T0)?.modelId).toBe("openai/gpt-x");
        expect(a.store.history("OpenAI/GPT-X")).toHaveLength(1);
        const stored = a.conn.prepare("SELECT model_id FROM model_price_history").all() as Array<{ model_id: string }>;
        expect(stored).toEqual([{ model_id: "openai/gpt-x" }]);
    });

    it("37f6c511 FS2-AC1: null (absent) and 0 (free) rates are preserved distinctly, and null->0 counts as a change", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        a.store.applyObservation(
            ledgerId,
            [row("v/free", 0, 0, { cacheReadPerM: 0, cacheWritePerM: null })],
            T0,
            new Set()
        );
        const r = must(a.store.latest("v/free"));
        expect(r.inputPerM).toBe(0);
        expect(r.outputPerM).toBe(0);
        expect(r.cacheReadPerM).toBe(0);
        expect(r.cacheWritePerM).toBeNull();
        const res = a.store.applyObservation(
            ledgerId,
            [row("v/free", 0, 0, { cacheReadPerM: null, cacheWritePerM: null })],
            T1,
            new Set()
        );
        expect(res.changedIds).toHaveLength(1); // 0 -> null is a real difference
        expect(a.store.latest("v/free")?.cacheReadPerM).toBeNull();
    });

    it("37f6c511 FS2-AC14: router rows keep null rates and kind 'router'; overrides are stored verbatim", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        a.store.applyObservation(
            ledgerId,
            [
                row("openrouter/auto", null, null, { kind: "router", rawJson: '{"prompt":"-1","completion":"-1"}' }),
                row("v/with-overrides", 1, 2, { overridesJson: '[{"over":"200000","prompt":"0.000002"}]' }),
            ],
            T0,
            new Set()
        );
        const router = must(a.store.priceAt("openrouter/auto", T1));
        expect(router.kind).toBe("router");
        expect([router.inputPerM, router.cacheReadPerM, router.cacheWritePerM, router.outputPerM]).toEqual([
            null,
            null,
            null,
            null,
        ]);
        const o = must(a.store.latest("v/with-overrides"));
        expect(o.overridesJson).toBe('[{"over":"200000","prompt":"0.000002"}]');
        expect(o.inputPerM).toBe(1); // overrides applied to nothing
    });

    it("37f6c511 FS2-AC8: a >=20x move is held (no row, price unchanged); accept releases it; 10x is applied with a warning", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        a.store.applyObservation(ledgerId, [row("v/m", 1, 2)], T0, new Set());

        const held = a.store.applyObservation(ledgerId, [row("v/m", 25, 2)], T1, new Set());
        expect(held.changedIds).toEqual([]);
        expect(held.anomalies).toEqual([
            expect.objectContaining({ modelId: "v/m", severity: "hold", field: "inputPerM", previous: 1, observed: 25 }),
        ]);
        expect(a.store.latest("v/m")?.inputPerM).toBe(1);

        const released = a.store.applyObservation(ledgerId, [row("v/m", 25, 2)], T1, new Set(["V/M"]));
        expect(released.changedIds).toHaveLength(1);
        expect(a.store.latest("v/m")?.inputPerM).toBe(25);

        // 25 -> 2.5 is a 10x drop: applied, warned.
        const warned = a.store.applyObservation(ledgerId, [row("v/m", 2.5, 2)], T2, new Set());
        expect(warned.changedIds).toHaveLength(1);
        expect(warned.anomalies.map((x) => x.severity)).toEqual(["warn"]);
        expect(a.store.latest("v/m")?.inputPerM).toBe(2.5);
    });

    it("37f6c511 FS2-AC8: an input rate above the ceiling is held even for a brand-new model", () => {
        const { ledgerId } = a.store.claimPull(T0, { ...claimOpts, force: true }) as { ledgerId: string };
        const res = a.store.applyObservation(ledgerId, [row("v/huge", ANOMALY_MAX_INPUT_PER_M + 1, 1)], T0, new Set());
        expect(res.newIds).toEqual([]);
        expect(res.anomalies[0]).toMatchObject({ severity: "hold", modelId: "v/huge" });
        expect(a.store.latest("v/huge")).toBeUndefined();
    });

    it("37f6c511 FS2-AC16: seedBundled is idempotent per (model, fetchedAt) and a new snapshot appends", () => {
        const rows = [row("v/a", 1, 2), row("V/B", 3, 4), row("openrouter/auto", null, null, { kind: "router" })];
        expect(a.store.seedBundled(rows, T0)).toBe(3);
        expect(a.store.seedBundled(rows, T0)).toBe(0);
        expect(a.store.history("v/a")).toHaveLength(1);
        expect(a.store.latest("v/a")?.source).toBe("bundled");
        expect(a.store.latest("v/a")?.ledgerId).toBeNull();
        expect(a.store.seedBundled(rows, T1)).toBe(3);
        expect(a.store.history("v/a")).toHaveLength(2);
    });

    it("37f6c511 FS2-AC16: seed from a second connection to the same file is a no-op (cross-connection idempotency)", () => {
        const b = openSecond();
        const rows = [row("v/a", 1, 2), row("v/b", 3, 4)];
        expect(a.store.seedBundled(rows, T0)).toBe(2);
        expect(b.store.seedBundled(rows, T0)).toBe(0);
        expect(a.conn.prepare("SELECT count(*) AS n FROM model_price_history").get()).toEqual({ n: 2 });
    });

    it("37f6c511 FS3-AC4: createPriceSource returns undefined for unknown models and matches the store for known ones", () => {
        const source = createPriceSource(drizzle(a.conn) as never);
        expect(source.priceAt("never/seen", T1)).toBeUndefined(); // empty store
        a.store.seedBundled([row("v/known", 1, 2)], T0);
        expect(source.priceAt("v/other", T1)).toBeUndefined();
        expect(source.priceAt("V/Known", T1)).toEqual(a.store.priceAt("v/known", T1));
        expect(source.priceAt("v/known", "2000-01-01T00:00:00.000Z")?.beforeFirstObservation).toBe(true);
    });

    it("37f6c511 FS2-AC9: claimPull is gated by the 24h interval, force, and a live running row", () => {
        const first = a.store.claimPull(T0, claimOpts);
        expect(first.claimed).toBe(true);
        // A live running row blocks everyone, even a forced pull.
        expect(a.store.claimPull(T0, claimOpts)).toEqual({ claimed: false, reason: "running" });
        expect(a.store.claimPull(T0, { ...claimOpts, force: true })).toEqual({ claimed: false, reason: "running" });
        a.store.finishPull((first as { ledgerId: string }).ledgerId, { status: "ok", finishedAt: T0 });
        // Within 24h: fresh. Force overrides. At exactly 24h: claimable.
        expect(a.store.claimPull("2026-10-01T23:59:59.999Z", claimOpts)).toEqual({ claimed: false, reason: "fresh" });
        expect(a.store.claimPull("2026-10-01T23:59:59.999Z", { ...claimOpts, force: true }).claimed).toBe(true);
    });

    it("37f6c511 FS2-AC9: a crashed running row past the TTL is superseded (marked failed) and a new claim succeeds", () => {
        const first = a.store.claimPull(T0, claimOpts) as { ledgerId: string };
        const later = "2026-10-01T00:10:00.001Z"; // > 10 min
        const second = a.store.claimPull(later, claimOpts);
        expect(second.claimed).toBe(true);
        const old = a.conn.prepare("SELECT status, error FROM price_pull_ledger WHERE id = ?").get(first.ledgerId) as {
            status: string;
            error: string;
        };
        expect(old.status).toBe("failed");
        expect(old.error).toMatch(/superseded/);
    });

    it("37f6c511 FS2-AC9: two connections to one file DB racing claimPull yield exactly one claim", () => {
        const b = openSecond();
        const results = [a.store.claimPull(T0, claimOpts), b.store.claimPull(T0, claimOpts)];
        expect(results.filter((r) => r.claimed)).toHaveLength(1);
        expect(results.filter((r) => !r.claimed)).toEqual([{ claimed: false, reason: "running" }]);
        expect(a.conn.prepare("SELECT count(*) AS n FROM price_pull_ledger WHERE status = 'running'").get()).toEqual({ n: 1 });
    });

    it("37f6c511 FS2-AC9: claimPull takes the write lock up front (BEGIN IMMEDIATE): a competing writer makes it fail fast with SQLITE_BUSY instead of reading stale state", () => {
        const b = openSecond(0); // no busy wait: lock contention surfaces immediately
        a.conn.exec("BEGIN IMMEDIATE");
        try {
            expect(() => b.store.claimPull(T0, claimOpts)).toThrow(/SQLITE_BUSY|database is locked/i);
        } finally {
            a.conn.exec("ROLLBACK");
        }
        // Lock released: the claim now succeeds and is visible to the first connection.
        expect(b.store.claimPull(T0, claimOpts).claimed).toBe(true);
        expect(a.conn.prepare("SELECT count(*) AS n FROM price_pull_ledger").get()).toEqual({ n: 1 });
    });

    it("37f6c511 FS2-AC9: interleaved appends from two connections converge without lost or duplicate rows", () => {
        const b = openSecond();
        const [ra, rb] = [
            a.store.claimPull(T0, { ...claimOpts, force: true }),
            // second claim is refused while the first is running; finish it first
            { claimed: false } as const,
        ];
        expect(ra.claimed && !rb.claimed).toBe(true);
        const ledgerId = (ra as { ledgerId: string }).ledgerId;
        a.store.applyObservation(ledgerId, [row("v/a", 1, 2)], T0, new Set());
        // The other connection sees the committed row, finds it unchanged, and adds only the new model.
        const res = b.store.applyObservation(ledgerId, [row("v/a", 1, 2), row("v/b", 5, 6)], T1, new Set());
        expect(res).toMatchObject({ unchangedCount: 1 });
        expect(res.newIds).toHaveLength(1);
        expect(a.store.latest("v/b")?.inputPerM).toBe(5);
        expect(a.store.history("v/a")).toHaveLength(1);
    });

    it("37f6c511 FS2-AC18: lastLedger reports last ok / last failed and price age is not reset by a later failure", () => {
        const first = a.store.claimPull(T0, claimOpts) as { ledgerId: string };
        a.store.finishPull(first.ledgerId, { status: "ok", finishedAt: T0, modelsSeen: 3, newCount: 3, unchangedCount: 0, changedCount: 0 });
        const second = a.store.claimPull(T2, claimOpts) as { ledgerId: string };
        a.store.finishPull(second.ledgerId, {
            status: "failed",
            finishedAt: T2,
            httpStatus: 500,
            error: "boom",
            anomalies: [{ modelId: "v/a", severity: "warn", reason: "x" }],
        });
        const summary = a.store.lastLedger("2026-10-04T00:00:00.000Z");
        expect(summary.lastOk?.id).toBe(first.ledgerId);
        expect(summary.lastOk?.modelsSeen).toBe(3);
        expect(summary.lastFailed).toMatchObject({ id: second.ledgerId, status: "failed", httpStatus: 500, error: "boom" });
        expect(JSON.parse(must(must(summary.lastFailed).anomaliesJson))).toHaveLength(1);
        expect(summary.priceAgeHours).toBe(72); // T0 -> 2026-10-04, unaffected by the T2 failure
        const empty = new PriceHistoryStore(drizzle(openSecond().conn) as never);
        a.conn.exec("DELETE FROM price_pull_ledger");
        expect(empty.lastLedger(T0)).toEqual({ priceAgeHours: null });
    });

    it("37f6c511 FS5-AC2: history is returned in observed_at order and honours inclusive from/to bounds", () => {
        seedThree(a.store);
        expect(a.store.history("vendor/model-x").map((r) => r.inputPerM)).toEqual([1, 2, 3]);
        expect(a.store.history("vendor/model-x", T1).map((r) => r.inputPerM)).toEqual([2, 3]);
        expect(a.store.history("vendor/model-x", T0, T1).map((r) => r.inputPerM)).toEqual([1, 2]);
        expect(a.store.history("nobody/here")).toEqual([]);
    });
});
