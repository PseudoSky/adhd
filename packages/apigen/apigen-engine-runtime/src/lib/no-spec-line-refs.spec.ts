/**
 * guards: a production lib source cites a spec by file:line (e.g. dispatch-stream-encode.spec.ts:124), leaving a dangling pointer once the spec is edited
 * tier: S
 * cites: plan discovery-sweep-1014 blind-review C AC4
 *
 * plan discovery-sweep-1014 blind-review C AC4
 *
 * Failure mode: a production source comment cites a spec by `file.spec.ts:<line>`;
 * the line number drifts as soon as the spec is edited, leaving a dangling pointer
 * (batch.ts cited dispatch-stream-encode.spec.ts:124 after it stopped lining up).
 * Comments must reference the test by name instead.
 *
 * Tier: S (reads this package's own lib sources via node:fs; no subprocess, no network).
 * Gap statement: none; the source text is the artifact under test.
 * Item/criterion: plan discovery-sweep-1014 blind-review C AC4.
 * Risk map (Light): only `*.spec.ts:<digits>` is flagged; prose naming a spec file
 * without a line number stays legal.
 * Red run: against the unfixed batch.ts the assertion fails listing
 * `batch.ts: dispatch-stream-encode.spec.ts:124`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('plan discovery-sweep-1014 blind-review C AC4 — no file:line spec references in lib sources', () => {
  it('AC4: no non-spec lib source cites a spec by file:line', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue;
      const hits = readFileSync(join(dir, name), 'utf8').match(
        /[\w.-]+\.spec\.ts:\d+/g
      );
      for (const hit of hits ?? []) offenders.push(`${name}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});
