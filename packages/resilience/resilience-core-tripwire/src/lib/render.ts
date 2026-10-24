/**
 * Pure renderers of a status map (the sparse record `tw.status()` returns).
 *
 * A status command prints `renderStatusText(map)` and then ALWAYS
 * `statusJsonLine(map)` as its last line, for programmatic consumers.
 */
import type { JsonValue, TripwireRecord } from './types.js';

function shown(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return '(none)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function present(v: JsonValue | undefined): v is JsonValue {
  return v !== undefined && v !== null && v !== '';
}

/** Own entries whose value is a record (the map is sparse). */
function entries(
  map: Readonly<Record<string, TripwireRecord | null | undefined>>,
): Array<[string, TripwireRecord]> {
  const out: Array<[string, TripwireRecord]> = [];
  for (const k of Object.keys(map)) {
    const r = map[k];
    if (r !== null && r !== undefined) out.push([k, r]);
  }
  return out;
}

/**
 * The human status block, one block per tripped key:
 *
 * ```text
 * <key>: ⛔ TRIPPED
 *   reason:       ...
 *   trippedAt:    ...
 *   blockedCount: ...
 *   query:        ...
 *   pageUrl:      ...
 *   reverifiedAt: ...   (only when present)
 *   resolvedAt:   ...   (only when present)
 * ```
 *
 * or `No tripwires tripped.` for an empty map. No trailing newline.
 */
export function renderStatusText(
  map: Readonly<Record<string, TripwireRecord | null | undefined>>,
): string {
  const list = entries(map);
  if (list.length === 0) return 'No tripwires tripped.';
  const lines: string[] = [];
  for (const [key, r] of list) {
    const c = r.context;
    lines.push(`${key}: ⛔ TRIPPED`);
    lines.push(`  reason:       ${r.reason}`);
    lines.push(`  trippedAt:    ${r.trippedAt}`);
    lines.push(`  blockedCount: ${r.blockedCount}`);
    lines.push(`  query:        ${shown(c['query'])}`);
    lines.push(`  pageUrl:      ${shown(c['pageUrl'])}`);
    if (present(c['reverifiedAt'])) {
      lines.push(`  reverifiedAt: ${shown(c['reverifiedAt'])}`);
    }
    if (present(c['resolvedAt'])) {
      lines.push(`  resolvedAt:   ${shown(c['resolvedAt'])}`);
    }
  }
  return lines.join('\n');
}

/**
 * The machine line: exactly `{"type":"tripwireStatus","status":{...}}` on
 * one line. `status` is a plain object keyed by plain string keys, holding
 * only the keys that have a record (sparse).
 */
export function statusJsonLine(
  map: Readonly<Record<string, TripwireRecord | null | undefined>>,
): string {
  const status: Record<string, TripwireRecord> = {};
  for (const [k, r] of entries(map)) status[k] = r;
  return JSON.stringify({ type: 'tripwireStatus', status });
}
