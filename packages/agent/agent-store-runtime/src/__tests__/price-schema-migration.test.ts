/**
 * S0 (1f1c8598 / 37f6c511): migration 0012 + the drizzle schema for cost
 * provenance and the append-only price history. Real better-sqlite3, real
 * migration files (the ones agent-mcp ships), no mocks.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns } from "drizzle-orm";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../db/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const REAL_FOLDER = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-store-runtime");

const NEW_USAGE_COLUMNS = [
    "response_model",
    "cost_basis",
    "pricing_ref",
    "cost_status",
    "priced_cost_usd",
    "unpriced_tokens",
] as const;

interface IJournal {
    entries: Array<{ idx: number; tag: string }>;
}

/** Copy the real migrations folder, keeping only entries with idx <= maxIdx. */
function folderUpTo(dest: string, maxIdx: number): string {
    const out = join(dest, `upto-${maxIdx}`);
    mkdirSync(join(out, "meta"), { recursive: true });
    const journal = JSON.parse(
        readFileSync(join(REAL_FOLDER, "meta/_journal.json"), "utf8")
    ) as IJournal & Record<string, unknown>;
    journal.entries = journal.entries.filter((e) => e.idx <= maxIdx);
    writeFileSync(join(out, "meta/_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries) {
        cpSync(join(REAL_FOLDER, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
    }
    return out;
}

function columnsOf(db: Database.Database, table: string): string[] {
    return (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((r) => r.name);
}

describe("migration 0012: price history + cost provenance", () => {
    let scratch: string;
    let conn: Database.Database;

    beforeEach(() => {
        mkdirSync(SCRATCH_ROOT, { recursive: true });
        scratch = mkdtempSync(join(SCRATCH_ROOT, "price-mig-"));
        conn = new Database(":memory:");
    });

    afterEach(() => {
        conn.close();
        rmSync(scratch, { recursive: true, force: true });
    });

    const apply = (folder: string) => migrate(drizzle(conn), { migrationsFolder: folder });

    it("the 0012 journal entry and sql file exist and follow idx 11", () => {
        const journal = JSON.parse(
            readFileSync(join(REAL_FOLDER, "meta/_journal.json"), "utf8")
        ) as IJournal;
        // Pinned to idx 12 (not "the last entry"): later additive migrations (0013, ...) follow it.
        const entry = journal.entries.find((e) => e.idx === 12);
        expect(entry?.tag).toBe("0012_price_history_and_cost_provenance");
        expect(readdirSync(REAL_FOLDER)).toContain(`${entry?.tag}.sql`);
    });

    it("37f6c511 FS3-AC2: applies on an empty DB and creates the tables, indexes and triggers", () => {
        apply(REAL_FOLDER);
        const names = (kind: string) =>
            (
                conn
                    .prepare("SELECT name FROM sqlite_master WHERE type = ?")
                    .all(kind) as Array<{ name: string }>
            ).map((r) => r.name);
        expect(names("table")).toEqual(
            expect.arrayContaining(["model_price_history", "price_pull_ledger"])
        );
        expect(names("index")).toEqual(
            expect.arrayContaining([
                "idx_price_history_model_observed",
                "uq_price_history_obs",
                "idx_price_pull_ledger_started",
            ])
        );
        expect(names("trigger")).toEqual(
            expect.arrayContaining([
                "model_price_history_no_update",
                "model_price_history_no_delete",
            ])
        );
        expect(columnsOf(conn, "task_usage")).toEqual(
            expect.arrayContaining([...NEW_USAGE_COLUMNS])
        );
    });

    it("drizzle schema.ts columns match the migrated DB exactly (no schema/migration drift)", () => {
        apply(REAL_FOLDER);
        for (const [tableName, table] of [
            ["task_usage", schema.taskUsageTable],
            ["model_price_history", schema.modelPriceHistoryTable],
            ["price_pull_ledger", schema.pricePullLedgerTable],
        ] as const) {
            const declared = Object.values(getTableColumns(table))
                .map((c) => c.name)
                .sort();
            expect(columnsOf(conn, tableName).sort(), tableName).toEqual(declared);
        }
    });

    it("1f1c8598 FS1-AC6: on a DB at 0011 with data, 0012 is additive and legacy rows read NULL provenance with unchanged est_cost_usd", () => {
        apply(folderUpTo(scratch, 11));
        expect(columnsOf(conn, "task_usage")).not.toContain("cost_status");
        conn.exec(`
            INSERT INTO task_usage
                (task_id, agent_name, provider_type, model, input_tokens, output_tokens,
                 est_cost_usd, created_at)
            VALUES
                ('legacy-priced', 'a', 'openai', 'deepseek-v4-flash', 10, 5, 0.000123456789, '2026-01-01T00:00:00.000Z'),
                ('legacy-unpriced', 'a', 'openai', 'mystery', 10, 5, NULL, '2026-01-01T00:00:00.000Z')`);
        const before = conn
            .prepare("SELECT * FROM task_usage ORDER BY task_id")
            .all() as Array<Record<string, unknown>>;

        apply(REAL_FOLDER);

        const after = conn
            .prepare("SELECT * FROM task_usage ORDER BY task_id")
            .all() as Array<Record<string, unknown>>;
        expect(after).toHaveLength(2);
        for (let i = 0; i < after.length; i++) {
            for (const col of NEW_USAGE_COLUMNS) expect(after[i][col], col).toBeNull();
            // every pre-existing column is byte-identical
            for (const [k, v] of Object.entries(before[i])) expect(after[i][k], k).toEqual(v);
        }
        expect(after.find((r) => r.task_id === "legacy-priced")?.est_cost_usd).toBe(
            0.000123456789
        );
        expect(after.find((r) => r.task_id === "legacy-unpriced")?.est_cost_usd).toBeNull();
        // the migration added no row to the legacy tables
        expect(
            (conn.prepare("SELECT COUNT(*) c FROM model_price_history").get() as { c: number }).c
        ).toBe(0);
    });

    it("is idempotent via the migrator: re-running applies nothing and keeps data", () => {
        apply(REAL_FOLDER);
        conn.exec(`INSERT INTO price_pull_ledger (id, started_at, status, source_url)
                   VALUES ('l1', '2026-10-08T00:00:00.000Z', 'ok', 'https://x')`);
        const migrationRows = () =>
            (
                conn.prepare("SELECT COUNT(*) c FROM __drizzle_migrations").get() as {
                    c: number;
                }
            ).c;
        const n = migrationRows();
        expect(() => apply(REAL_FOLDER)).not.toThrow();
        expect(migrationRows()).toBe(n);
        expect(
            (conn.prepare("SELECT COUNT(*) c FROM price_pull_ledger").get() as { c: number }).c
        ).toBe(1);
    });

    describe("append-only model_price_history", () => {
        const insert = () =>
            conn.exec(`INSERT INTO model_price_history
                (id, model_id, observed_at, source, kind, input_per_m, output_per_m, raw_json)
                VALUES ('p1', 'deepseek/deepseek-v4.1-flash', '2026-10-08T00:00:00.000Z',
                        'openrouter-live', 'model', 0.3, 1.2, '{"prompt":"0.0000003"}')`);

        it("37f6c511 FS3-AC2: INSERT works, UPDATE and DELETE are rejected and the row is unchanged", () => {
            apply(REAL_FOLDER);
            insert();
            expect(() =>
                conn.exec("UPDATE model_price_history SET input_per_m = 99 WHERE id = 'p1'")
            ).toThrow(/append-only/);
            expect(() => conn.exec("DELETE FROM model_price_history WHERE id = 'p1'")).toThrow(
                /append-only/
            );
            const row = conn.prepare("SELECT input_per_m FROM model_price_history").get() as {
                input_per_m: number;
            };
            expect(row.input_per_m).toBe(0.3);
        });

        it("37f6c511 FS3-AC2 negative control: with the triggers stripped from a copy of 0012, the same UPDATE succeeds (the triggers are what block it)", () => {
            const folder = folderUpTo(scratch, 12);
            const sqlPath = join(folder, "0012_price_history_and_cost_provenance.sql");
            const stripped = readFileSync(sqlPath, "utf8")
                .split("--> statement-breakpoint")
                .filter((stmt) => !/CREATE TRIGGER/.test(stmt))
                .join("--> statement-breakpoint");
            writeFileSync(sqlPath, stripped);
            apply(folder);
            insert();
            conn.exec("UPDATE model_price_history SET input_per_m = 99 WHERE id = 'p1'");
            const row = conn.prepare("SELECT input_per_m FROM model_price_history").get() as {
                input_per_m: number;
            };
            expect(row.input_per_m).toBe(99);
        });

        it("uniqueness: same (model_id, observed_at, source) is rejected; distinct source is allowed; 0 and NULL rates stay distinct", () => {
            apply(REAL_FOLDER);
            insert();
            expect(() =>
                conn.exec(`INSERT INTO model_price_history (id, model_id, observed_at, source, raw_json)
                           VALUES ('p2', 'deepseek/deepseek-v4.1-flash', '2026-10-08T00:00:00.000Z', 'openrouter-live', '{}')`)
            ).toThrow(/UNIQUE/);
            conn.exec(`INSERT INTO model_price_history (id, model_id, observed_at, source, raw_json, input_per_m)
                       VALUES ('p3', 'deepseek/deepseek-v4.1-flash', '2026-10-08T00:00:00.000Z', 'bundled', '{}', 0)`);
            const rows = conn
                .prepare("SELECT id, input_per_m, output_per_m, kind FROM model_price_history ORDER BY id")
                .all() as Array<{ id: string; input_per_m: number | null; output_per_m: number | null; kind: string }>;
            expect(rows.find((r) => r.id === "p3")).toMatchObject({
                input_per_m: 0,
                output_per_m: null,
                kind: "model",
            });
        });
    });

    it("drizzle round-trip through the schema objects for the new tables and columns", () => {
        apply(REAL_FOLDER);
        const db = drizzle(conn, { schema });
        db.insert(schema.pricePullLedgerTable)
            .values({ id: "l1", startedAt: "2026-10-08T00:00:00.000Z", status: "running", sourceUrl: "https://openrouter.ai/api/v1/models" })
            .run();
        db.insert(schema.modelPriceHistoryTable)
            .values({ id: "p1", modelId: "m", observedAt: "2026-10-08T00:00:00.000Z", source: "bundled", rawJson: "{}", ledgerId: null })
            .run();
        db.insert(schema.taskUsageTable)
            .values({
                taskId: "t1", agentName: "a", providerType: "openai", model: "deepseek-flash",
                createdAt: "2026-10-08T00:00:00.000Z",
                responseModel: "deepseek-v4-flash-0731", costBasis: "owner-assumption",
                pricingRef: "bundled:x:m", costStatus: "priced", pricedCostUsd: 0.5, unpricedTokens: 0,
            })
            .run();
        const [u] = db.select().from(schema.taskUsageTable).all();
        expect(u).toMatchObject({ responseModel: "deepseek-v4-flash-0731", costStatus: "priced", pricedCostUsd: 0.5, unpricedTokens: 0 });
        const [h] = db.select().from(schema.modelPriceHistoryTable).all();
        expect(h.kind).toBe("model");
    });
});
