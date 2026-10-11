/**
 * Facts about the shipped migration journal, DERIVED from it so migration tests do not hardcode counts or indexes
 * that the next migration would silently invalidate. (b3999dfa AC6)
 */
import { readFileSync } from "node:fs";
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
