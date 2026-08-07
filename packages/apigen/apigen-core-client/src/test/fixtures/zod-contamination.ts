// Fixture for BUG-APIGEN-CORE-001: zod-contaminated $ref resolution
// A source file that transitively imports zod through a re-export.
// The goal: verify that generated schemas are clean even when zod types
// appear in the type resolution graph.
//
// We import directly from zod to keep this self-contained (no external
// dependency on @modelcontextprotocol/sdk needed for the test).

import { z } from 'zod';

// A Zod schema defined locally — just using the import is enough for
// ts-json-schema-generator to discover ZodString/ZodNumber/etc. types.
const _unused = z.string();

// A plain user function whose schema should NOT be affected by the
// zod import above.  This is the "canary" — if the fix works, this
// function's schema is clean; if not, it contains corrupted $ref entries.
export interface CalibrateResult {
  status: string;
  score: number;
}

export function calibrate(): CalibrateResult {
  return { status: 'ok', score: 42 };
}
