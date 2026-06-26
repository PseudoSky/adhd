import { describe, it, expect } from 'vitest';
import {
  CANONICAL_LOGICAL_TYPE_IDS,
  TEMPLATE_CELLS,
  assertNoEmptyCells,
  tsDepMap,
  cellsFor,
  depsForLogicalTypes,
  type HostLanguage,
  type LanguageTable,
} from './hints';
import type { TemplateCell } from './contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All host languages that have a column in TEMPLATE_CELLS. */
const ALL_LANGUAGES: readonly HostLanguage[] = [
  'typescript',
  'python',
  'rust',
  'go',
  'java',
];

/** The stdlib-only canonical ids in the TypeScript column (no dep entry). */
const TS_STDLIB_IDS = ['date-time', 'int64', 'byte', 'uuid', 'number-special'] as const;

// ---------------------------------------------------------------------------
// 1. Every canonical id has a filled TS cell AND a filled Python cell.
//    Goes RED if any cell is dropped (uses CANONICAL_LOGICAL_TYPE_IDS
//    directly — NOT a hard-coded literal list).
// ---------------------------------------------------------------------------

describe('TEMPLATE_CELLS completeness — TypeScript column', () => {
  for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
    it(`has a cell for canonical id "${id}"`, () => {
      const cell: TemplateCell | undefined =
        TEMPLATE_CELLS.typescript[id as keyof LanguageTable];
      expect(cell).toBeDefined();
      // A cell must have non-empty encode/decode strings.
      expect(typeof cell!.encode).toBe('string');
      expect(cell!.encode.length).toBeGreaterThan(0);
      expect(typeof cell!.decode).toBe('string');
      expect(cell!.decode.length).toBeGreaterThan(0);
      // mode must be one of the three valid values.
      expect(['native', 'lib', 'branded']).toContain(cell!.mode);
    });
  }
});

describe('TEMPLATE_CELLS completeness — Python column', () => {
  for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
    it(`has a cell for canonical id "${id}"`, () => {
      const cell: TemplateCell | undefined =
        TEMPLATE_CELLS.python[id as keyof LanguageTable];
      expect(cell).toBeDefined();
      expect(typeof cell!.encode).toBe('string');
      expect(cell!.encode.length).toBeGreaterThan(0);
      expect(typeof cell!.decode).toBe('string');
      expect(cell!.decode.length).toBeGreaterThan(0);
      expect(['native', 'lib', 'branded']).toContain(cell!.mode);
    });
  }
});

describe('TEMPLATE_CELLS completeness — scaffolded columns', () => {
  for (const lang of ALL_LANGUAGES) {
    it(`language "${lang}" has an entry for every canonical id`, () => {
      // This is the assertion that drives the §13.3 guarantee for all columns.
      for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
        const cell = TEMPLATE_CELLS[lang][id as keyof LanguageTable];
        expect(
          cell,
          `Language "${lang}" is missing a cell for canonical id "${id}"`,
        ).toBeDefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. tsDepMap() — per-surface minimal-manifest guarantee (DESIGN §14.1)
// ---------------------------------------------------------------------------

describe('tsDepMap()', () => {
  it('maps "decimal" → decimal.js', () => {
    const map = tsDepMap();
    expect(map['decimal']).toBeDefined();
    expect(map['decimal']!.name).toBe('decimal.js');
    expect(map['decimal']!.version).toMatch(/^\^10/);
  });

  it('does NOT include a dep for "date-time" (stdlib)', () => {
    const map = tsDepMap();
    expect(map['date-time']).toBeUndefined();
  });

  it('does NOT include a dep for "int64" (stdlib BigInt)', () => {
    const map = tsDepMap();
    expect(map['int64']).toBeUndefined();
  });

  it('does NOT include a dep for "byte" (stdlib Buffer)', () => {
    const map = tsDepMap();
    expect(map['byte']).toBeUndefined();
  });

  it('does NOT include a dep for "uuid" (branded string, no dep)', () => {
    const map = tsDepMap();
    expect(map['uuid']).toBeUndefined();
  });

  it('does NOT include a dep for "number-special" (stdlib helper)', () => {
    const map = tsDepMap();
    expect(map['number-special']).toBeUndefined();
  });

  it('returns a frozen object (immutable)', () => {
    const map = tsDepMap();
    expect(Object.isFrozen(map)).toBe(true);
  });

  it('only contains entries for types that actually have deps (no accidental stdlib leakage)', () => {
    const map = tsDepMap();
    for (const id of TS_STDLIB_IDS) {
      expect(
        map[id],
        `tsDepMap() must not contain an entry for stdlib id "${id}"`,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Negative control: assertNoEmptyCells throws for an incomplete column
//    (proves the completeness check is not vacuous — DESIGN §13.3)
// ---------------------------------------------------------------------------

describe('assertNoEmptyCells — negative control', () => {
  it('does NOT throw for the fully-filled TypeScript column', () => {
    expect(() => assertNoEmptyCells('typescript')).not.toThrow();
  });

  it('does NOT throw for the fully-filled Python column', () => {
    expect(() => assertNoEmptyCells('python')).not.toThrow();
  });

  it('does NOT throw for any scaffolded column (structure complete)', () => {
    for (const lang of ALL_LANGUAGES) {
      expect(
        () => assertNoEmptyCells(lang),
        `assertNoEmptyCells("${lang}") must not throw — column is complete`,
      ).not.toThrow();
    }
  });

  it('DOES throw when a language column is missing a cell (drives the REAL assertNoEmptyCells)', () => {
    // DEBT-LT-007: build a deliberately-incomplete column (all ids except
    // 'decimal') and pass it as the _tableOverride to drive the PRODUCTION
    // assertNoEmptyCells throw path. The prior test reimplemented checkTable
    // inline and never called the production function.
    const incomplete: Partial<LanguageTable> = {};
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      if (id !== 'decimal') {
        incomplete[id as keyof LanguageTable] = {
          encode: 'dummy_encode($)',
          decode: 'dummy_decode($)',
          mode: 'native',
        };
      }
    }

    // The PRODUCTION assertNoEmptyCells must throw for the incomplete column.
    expect(() => assertNoEmptyCells('typescript', incomplete)).toThrow(
      /missing cells for:.*decimal/,
    );

    // Negative control: a COMPLETE table must NOT throw — the guard only fires
    // when a cell is genuinely absent. If this assertion fails, the guard is
    // broken (false positives on valid columns).
    const complete: Partial<LanguageTable> = {};
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      complete[id as keyof LanguageTable] = {
        encode: 'dummy_encode($)',
        decode: 'dummy_decode($)',
        mode: 'native',
      };
    }
    expect(() => assertNoEmptyCells('typescript', complete)).not.toThrow();
  });

  it('thrown error message names EVERY missing id (multiple-missing teeth)', () => {
    // Build a column missing 'byte' and 'uuid' — both must appear in the message.
    const missingTwo: Partial<LanguageTable> = {};
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      if (id !== 'byte' && id !== 'uuid') {
        missingTwo[id as keyof LanguageTable] = {
          encode: 'x',
          decode: 'x',
          mode: 'native',
        };
      }
    }

    // Drive the PRODUCTION assertNoEmptyCells — it must name both missing ids.
    expect(() => assertNoEmptyCells('typescript', missingTwo)).toThrowError(/byte/);
    expect(() => assertNoEmptyCells('typescript', missingTwo)).toThrowError(/uuid/);

    // Negative control: a complete table must NOT throw.
    const complete: Partial<LanguageTable> = {};
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      complete[id as keyof LanguageTable] = {
        encode: 'x',
        decode: 'x',
        mode: 'native',
      };
    }
    expect(() => assertNoEmptyCells('typescript', complete)).not.toThrow();
  });

  // Legacy: old test that reimplemented checkTable inline (kept as a
  // commented example of what NOT to do — DEBT-LT-007 fixed it above).
  it('(backward compat) production assertNoEmptyCells succeeds for all scaffolded languages', () => {
    // Simple smoke-test that confirms the guard passes for all real columns.
    for (const lang of ALL_LANGUAGES) {
      expect(
        () => assertNoEmptyCells(lang),
        `assertNoEmptyCells("${lang}") must not throw — column is complete`,
      ).not.toThrow();
    }
  });

  it('_LEGACY_thrown error message names the missing ids (proves the check has teeth)', () => {
    // Build a custom completeness check over an incomplete synthetic table
    // to verify the error message contract without monkey-patching frozen exports.
    function checkTable(table: Partial<LanguageTable>): void {
      const missing: string[] = [];
      for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
        if (!table[id as keyof LanguageTable]) {
          missing.push(id);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `[hints] assertNoEmptyCells: language "synthetic" is missing cells for: ${missing.join(', ')}`,
        );
      }
    }

    // A table missing 'byte' and 'uuid'.
    const missingTwo: Partial<LanguageTable> = {};
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      if (id !== 'byte' && id !== 'uuid') {
        missingTwo[id as keyof LanguageTable] = {
          encode: 'x',
          decode: 'x',
          mode: 'native',
        };
      }
    }

    expect(() => checkTable(missingTwo)).toThrowError(/byte/);
    expect(() => checkTable(missingTwo)).toThrowError(/uuid/);

    // A COMPLETE table must NOT throw.
    const complete: LanguageTable = {} as LanguageTable;
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      complete[id as keyof LanguageTable] = {
        encode: 'x',
        decode: 'x',
        mode: 'native',
      };
    }
    expect(() => checkTable(complete)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. cellsFor() — typed accessor returns the correct column
// ---------------------------------------------------------------------------

describe('cellsFor()', () => {
  it('returns the TypeScript column', () => {
    expect(cellsFor('typescript')).toBe(TEMPLATE_CELLS.typescript);
  });

  it('returns the Python column', () => {
    expect(cellsFor('python')).toBe(TEMPLATE_CELLS.python);
  });

  it('returns a column with all canonical ids filled', () => {
    for (const lang of ALL_LANGUAGES) {
      const col = cellsFor(lang);
      for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
        expect(col[id as keyof LanguageTable]).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. depsForLogicalTypes() — returns only the types that have deps
// ---------------------------------------------------------------------------

describe('depsForLogicalTypes()', () => {
  it('returns the decimal.js dep for ["decimal"] in TypeScript', () => {
    const deps = depsForLogicalTypes(['decimal'], 'typescript');
    expect(deps).toHaveLength(1);
    expect(deps[0]!.id).toBe('decimal');
    expect(deps[0]!.dep.name).toBe('decimal.js');
  });

  it('returns nothing for stdlib-only ids in TypeScript', () => {
    const deps = depsForLogicalTypes(
      ['date-time', 'int64', 'byte', 'uuid', 'number-special'],
      'typescript',
    );
    expect(deps).toHaveLength(0);
  });

  it('returns no deps for Python (all stdlib)', () => {
    // Python column is explicitly zero 3rd-party deps per DESIGN §13.2.
    const deps = depsForLogicalTypes([...CANONICAL_LOGICAL_TYPE_IDS], 'python');
    expect(deps).toHaveLength(0);
  });

  it('handles an empty ids array gracefully', () => {
    expect(depsForLogicalTypes([], 'typescript')).toEqual([]);
  });

  it('ignores unknown ids (no cell → no dep entry returned)', () => {
    const deps = depsForLogicalTypes(['nonexistent-type'], 'typescript');
    expect(deps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. TypeScript TS cell value spot-checks (DESIGN §13.2 verbatim)
// ---------------------------------------------------------------------------

describe('TypeScript column — verbatim expressions from DESIGN §13.2', () => {
  it('date-time encode is "$.toISOString()"', () => {
    expect(TEMPLATE_CELLS.typescript['date-time'].encode).toBe('$.toISOString()');
  });

  it('date-time decode is "new Date($)"', () => {
    expect(TEMPLATE_CELLS.typescript['date-time'].decode).toBe('new Date($)');
  });

  it('int64 encode is "String($)"', () => {
    expect(TEMPLATE_CELLS.typescript['int64'].encode).toBe('String($)');
  });

  it('int64 decode is "BigInt($)"', () => {
    expect(TEMPLATE_CELLS.typescript['int64'].decode).toBe('BigInt($)');
  });

  it('decimal mode is "branded" (zero-dep default, DESIGN §13.2 / §18)', () => {
    expect(TEMPLATE_CELLS.typescript['decimal'].mode).toBe('branded');
  });

  it('decimal dep is decimal.js ^10', () => {
    const dep = TEMPLATE_CELLS.typescript['decimal'].dep;
    expect(dep).toBeDefined();
    expect(dep!.name).toBe('decimal.js');
    expect(dep!.version).toBe('^10');
  });
});

// ---------------------------------------------------------------------------
// 7. Python column — spot-checks (DESIGN §13.2 verbatim)
// ---------------------------------------------------------------------------

describe('Python column — verbatim expressions from DESIGN §13.2', () => {
  it('date-time encode is "$.isoformat()"', () => {
    expect(TEMPLATE_CELLS.python['date-time'].encode).toBe('$.isoformat()');
  });

  it('date-time decode is "datetime.fromisoformat($)"', () => {
    expect(TEMPLATE_CELLS.python['date-time'].decode).toBe('datetime.fromisoformat($)');
  });

  it('date-time imports include "from datetime import datetime"', () => {
    expect(TEMPLATE_CELLS.python['date-time'].imports).toContain(
      'from datetime import datetime',
    );
  });

  it('int64 encode is "str($)"', () => {
    expect(TEMPLATE_CELLS.python['int64'].encode).toBe('str($)');
  });

  it('int64 decode is "int($)"', () => {
    expect(TEMPLATE_CELLS.python['int64'].decode).toBe('int($)');
  });

  it('decimal decode is "Decimal($)"', () => {
    expect(TEMPLATE_CELLS.python['decimal'].decode).toBe('Decimal($)');
  });

  it('decimal imports include "from decimal import Decimal"', () => {
    expect(TEMPLATE_CELLS.python['decimal'].imports).toContain(
      'from decimal import Decimal',
    );
  });

  it('uuid decode is "UUID($)"', () => {
    expect(TEMPLATE_CELLS.python['uuid'].decode).toBe('UUID($)');
  });

  it('uuid imports include "from uuid import UUID"', () => {
    expect(TEMPLATE_CELLS.python['uuid'].imports).toContain('from uuid import UUID');
  });

  it('byte decode is "b64decode($)"', () => {
    expect(TEMPLATE_CELLS.python['byte'].decode).toBe('b64decode($)');
  });

  it('no Python cell has a dep (all stdlib — DESIGN §13.2)', () => {
    for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
      const cell = TEMPLATE_CELLS.python[id as keyof LanguageTable];
      expect(
        cell.dep,
        `Python cell for "${id}" must have no dep (all stdlib)`,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Immutability — TEMPLATE_CELLS is frozen
// ---------------------------------------------------------------------------

describe('TEMPLATE_CELLS immutability', () => {
  it('the outer TEMPLATE_CELLS object is frozen', () => {
    expect(Object.isFrozen(TEMPLATE_CELLS)).toBe(true);
  });
});
