/**
 * Facts about the shipped migration journal, DERIVED from it so migration tests do not hardcode counts or indexes
 * that the next migration would silently invalidate. (b3999dfa AC6)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MIGRATIONS_FOLDER } from "../../db/migrate-runner.js";

export interface IJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** Every entry of the shipped `_journal.json`, in order. */
export function journalEntries(): IJournalEntry[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: IJournalEntry[] };
  return journal.entries;
}

/** Rows a fully migrated `__drizzle_migrations` ledger holds: one per journal entry. */
export function expectedLedgerRows(): number {
  return journalEntries().length;
}

/** The entry whose SQL first adds `task_usage.cache_creation_1h_tokens` (8333f755 AC3's migration under test). */
export function cacheCreation1hEntry(): IJournalEntry {
  const hit = journalEntries().find((e) => /ADD[^;]*cache_creation_1h_tokens/i.test(readFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), "utf8")));
  if (!hit) throw new Error("no migration in the journal adds cache_creation_1h_tokens");
  return hit;
}

/** The last journal idx BEFORE the cache_creation_1h migration: the "old schema" the race tests seed. */
export function idxBeforeCacheCreation1h(): number {
  return cacheCreation1hEntry().idx - 1;
}

/** The tag of the entry at `idx` (the newest migration present in a database seeded up to it). */
export function tagAt(idx: number): string {
  const hit = journalEntries().find((e) => e.idx === idx);
  if (!hit) throw new Error(`no journal entry with idx ${idx}`);
  return hit.tag;
}

/** The entry whose SQL creates `message_provider_echo` (R9-hist AC11's migration under test). */
export function providerEchoEntry(): IJournalEntry {
  const hit = journalEntries().find((e) => /CREATE TABLE[^;]*message_provider_echo/i.test(readFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), "utf8")));
  if (!hit) throw new Error("no migration in the journal creates message_provider_echo");
  return hit;
}

/** The last journal idx BEFORE the provider-echo migration: the schema a previous-version binary wrote. */
export function idxBeforeProviderEcho(): number {
  return providerEchoEntry().idx - 1;
}

/**
 * A copy of the shipped migrations folder under `parent`, holding only entries with idx <= `maxIdx`.
 * `rewrite` replaces the SQL of named tags (a deliberately-wrong variant for a negative control); `extra` appends
 * entries after the last kept one (idx and `when` continue the journal), e.g. a non-additive migration.
 */
export function migrationsFolderUpTo(
  maxIdx: number,
  parent: string,
  opts: { name?: string; rewrite?: Record<string, string>; extra?: Array<{ tag: string; sql: string }> } = {},
): string {
  const root = join(parent, opts.name ?? `upto-${maxIdx}`);
  mkdirSync(join(root, "meta"), { recursive: true });
  const kept = journalEntries().filter((e) => e.idx <= maxIdx);
  for (const e of kept) {
    const sql = opts.rewrite?.[e.tag] ?? readFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), "utf8");
    writeFileSync(join(root, `${e.tag}.sql`), sql);
  }
  const entries: Array<IJournalEntry & { version: string; breakpoints: boolean }> = kept.map((e) => ({ ...e, version: "6", breakpoints: true }));
  let last = kept[kept.length - 1];
  for (const x of opts.extra ?? []) {
    const next = { idx: last.idx + 1, tag: x.tag, when: last.when + 1 };
    entries.push({ ...next, version: "6", breakpoints: true });
    writeFileSync(join(root, `${x.tag}.sql`), x.sql);
    last = next;
  }
  writeFileSync(join(root, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
  return root;
}
