import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { DataView, Query, orderBy } from './index';

// This spec lives next to the barrel it guards, so the barrel's own source is
// the fixture — no tmp artifact, no nx cache blindness risk.
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('index barrel', () => {
  it('re-exports the runtime query API', () => {
    expect(DataView).toBeDefined();
    expect(Query).toBeDefined();
    expect(orderBy).toBeDefined();
    expect(new DataView([{ a: 1 }]).view()).toEqual([{ a: 1 }]);
  });

  // Source-presence guard for the type-only expressions re-export. vitest strips
  // types, so a dropped `export type * from './lib/expressions'` is invisible to
  // the runtime module graph — this text assertion is the only in-repo gate that
  // the barrel actually forwards the expressions module.
  it('re-exports ./lib/expressions from index.ts', () => {
    const source = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf-8');
    const reExportsExpressions = source
      .split('\n')
      .map((line) => line.trim())
      .some((line) =>
        /^export\s+(type\s+)?\*\s+from\s+['"]\.\/lib\/expressions['"];?$/u.test(
          line
        )
      );
    expect(reExportsExpressions).toBe(true);
  });
});
