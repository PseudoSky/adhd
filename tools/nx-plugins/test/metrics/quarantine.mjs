/**
 * quarantine — the registry of tests excluded from the G5 gate while a tracking item is open (T36.AC2).
 *
 * `quarantine.json` holds `{ "entries": [{ "test": "<file> :: <name substring>", "id": "<8 hex>", "until": "YYYY-MM-DD", "reason": "..." }] }`.
 * A quarantined test is EXCLUDED from the gate's flaky share and its flake and retry violations, but it still runs in
 * every lane and its executions are still recorded and listed by `flaky` and `g5` under `quarantined` (the exclusion
 * is of the gate's verdict, never of the run). Past `until` the entry is a violation (`quarantine-expired`), so a
 * quarantine cannot become permanent; a malformed entry (no 8-hex id, no real date, no test) is a violation too.
 * The id is format-checked only: this check is offline, so it cannot prove the item exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUARANTINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'quarantine.json');
const ID = /^[0-9a-f]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Read the registry. A missing file is an empty registry; an unreadable or malformed file throws (never silently empty). */
export function loadQuarantine(file = QUARANTINE_PATH) {
  if (!existsSync(file)) return { entries: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error(`${file}: expected { "entries": [...] }`);
  return parsed;
}

/**
 * Split the registry into active entries and violations as of `today`.
 * @returns {{ active: object[], violations: { rule: string, entry: object, message: string }[] }}
 */
export function checkQuarantine(registry, today = new Date().toISOString().slice(0, 10)) {
  const active = [];
  const violations = [];
  for (const entry of registry.entries) {
    const bad = (rule, message) => violations.push({ rule, entry, message });
    if (typeof entry.test !== 'string' || entry.test.trim() === '') { bad('quarantine-malformed', 'an entry names no test'); continue; }
    if (typeof entry.id !== 'string' || !ID.test(entry.id)) { bad('quarantine-malformed', `${entry.test}: id must be 8 hex characters (a tracking item)`); continue; }
    if (typeof entry.until !== 'string' || !isRealDate(entry.until)) { bad('quarantine-malformed', `${entry.test}: until must be a real YYYY-MM-DD date`); continue; }
    if (entry.until < today) { bad('quarantine-expired', `${entry.test}: quarantine ended ${entry.until} (item ${entry.id}); fix the test or renew it with a reason`); continue; }
    active.push(entry);
  }
  return { active, violations };
}

/** True when `testKey` (`<file> :: <name>`) is covered by an active entry (substring match, as `history` uses). */
export function isQuarantined(active, testKey) {
  return active.some((e) => testKey.includes(e.test));
}
