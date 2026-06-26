/**
 * @stable Template-cell registry — the single source of truth that, for each
 * logical type × each host language, declares how the codegen emitter builds
 * its (de)hydration glue: the native `encode`/`decode` expressions, file
 * `imports`, 3rd-party `dep`, and `mode` (native|lib|branded).
 *
 * DESIGN §13.1 — cell shape
 * DESIGN §13.2 — filled TypeScript and Python columns (verbatim values)
 * DESIGN §13.3 — "no empty cells" completeness enforcement
 * DESIGN §14.1 — `tsDepMap()` feeds the generated per-surface dep manifest
 *
 * The keys MUST match the codec `id` values registered by `registerWellKnown`
 * (DESIGN §3 / `codecs/index.ts`). The set is derived from the same imported
 * codec list so the table can never silently drift from the codec set.
 */

import type { TemplateCell } from './contracts';
import {
  dateTimeCodec,
  int64Codec,
  decimalCodec,
  byteCodec,
  uuidCodec,
  numberSpecialCodec,
} from './codecs/index';

// ---------------------------------------------------------------------------
// Canonical id list — derived from the registered codecs, not hard-coded.
// This is the single list that drives the completeness assertion in §13.3.
// ---------------------------------------------------------------------------

/**
 * @stable The ordered list of well-known scalar logical-type ids, derived
 * from the canonical codec set.  Every language column in {@link TEMPLATE_CELLS}
 * MUST have an entry for each of these ids.
 */
export const CANONICAL_LOGICAL_TYPE_IDS = [
  dateTimeCodec.id,   // 'date-time'
  int64Codec.id,      // 'int64'
  decimalCodec.id,    // 'decimal'
  byteCodec.id,       // 'byte'
  uuidCodec.id,       // 'uuid'
  numberSpecialCodec.id, // 'number-special'
] as const satisfies ReadonlyArray<string>;

/** @stable Union of the canonical well-known scalar ids. */
export type CanonicalLogicalTypeId = (typeof CANONICAL_LOGICAL_TYPE_IDS)[number];

// ---------------------------------------------------------------------------
// Per-language template table type
// ---------------------------------------------------------------------------

/**
 * @stable A fully-keyed per-language template table: maps every canonical
 * logical-type id to its {@link TemplateCell}.
 */
export type LanguageTable = Record<CanonicalLogicalTypeId, TemplateCell>;

// ---------------------------------------------------------------------------
// Supported host languages
// ---------------------------------------------------------------------------

/**
 * @stable The host languages for which a template column exists in
 * {@link TEMPLATE_CELLS}.  `'typescript'` and `'python'` are fully filled
 * (§13.2 values verbatim).  `'rust'`, `'go'`, and `'java'` are scaffolded —
 * structure complete, expressions use stable placeholders pending the
 * `lt-host-*` states.
 */
export type HostLanguage = 'typescript' | 'python' | 'rust' | 'go' | 'java';

// ---------------------------------------------------------------------------
// TypeScript column (DESIGN §13.2 — verbatim)
// ---------------------------------------------------------------------------

const TYPESCRIPT_COLUMN: LanguageTable = {
  'date-time': {
    encode: '$.toISOString()',
    decode: 'new Date($)',
    mode: 'native',
  },

  'int64': {
    encode: 'String($)',
    decode: 'BigInt($)',
    mode: 'native',
  },

  'decimal': {
    // Default: branded string (zero-dep); opt-in to decimal.js for arithmetic.
    // DESIGN §13.2 branded row / §18 resolved: mode:'branded', dep declared so
    // generators can optionally inject it; consumers that never use Decimal
    // never install it (§14.2).
    encode: '$.toString()',
    decode: 'new Decimal($)',
    imports: [],
    dep: { name: 'decimal.js', version: '^10' },
    mode: 'branded',
  },

  'byte': {
    encode: "Buffer.from($).toString('base64')",
    decode: "new Uint8Array(Buffer.from($, 'base64'))",
    mode: 'native',
  },

  'uuid': {
    // UUID is a plain string in TS; encode normalises to lowercase.
    encode: '$.toLowerCase()',
    decode: '$',
    mode: 'native',
  },

  'number-special': {
    // numToWire / wireToNum are stdlib helpers emitted inline by the engine.
    encode: 'numToWire($)',
    decode: 'wireToNum($)',
    mode: 'native',
  },
};

// ---------------------------------------------------------------------------
// Python column (DESIGN §13.2 — verbatim; all stdlib, zero 3rd-party deps)
// ---------------------------------------------------------------------------

const PYTHON_COLUMN: LanguageTable = {
  'date-time': {
    encode: '$.isoformat()',
    decode: 'datetime.fromisoformat($)',
    imports: ['from datetime import datetime'],
    mode: 'native',
  },

  'int64': {
    encode: 'str($)',
    decode: 'int($)',
    mode: 'native',
  },

  'decimal': {
    encode: 'str($)',
    decode: 'Decimal($)',
    imports: ['from decimal import Decimal'],
    mode: 'native',
  },

  'byte': {
    encode: 'b64encode($).decode()',
    decode: 'b64decode($)',
    imports: ['from base64 import b64encode, b64decode'],
    mode: 'native',
  },

  'uuid': {
    encode: 'str($)',
    decode: 'UUID($)',
    imports: ['from uuid import UUID'],
    mode: 'native',
  },

  'number-special': {
    // Python json.dumps maps float('nan')/float('inf') to null by default;
    // the codec overrides with string sentinels (same as TS).
    encode: 'num_to_wire($)',
    decode: 'wire_to_num($)',
    mode: 'native',
  },
};

// ---------------------------------------------------------------------------
// Rust column (DESIGN §13.2 scaffolded — `#[serde(with=…)]` attributes)
// The expressions here are Rust attribute syntax, not expression templates.
// Fully filled in `lt-host-rust`.
// ---------------------------------------------------------------------------

const RUST_COLUMN: LanguageTable = {
  'date-time': {
    // chrono::DateTime<Utc> serialises as RFC3339 via serde.
    encode: '__SCAFFOLD_RUST_DATETIME_ENCODE__',
    decode: '__SCAFFOLD_RUST_DATETIME_DECODE__',
    imports: ['use chrono::{DateTime, Utc};'],
    dep: { name: 'chrono', version: '^0.4' },
    mode: 'lib',
  },

  'int64': {
    // serde_with DisplayFromStr for i64/u64.
    encode: '__SCAFFOLD_RUST_INT64_ENCODE__',
    decode: '__SCAFFOLD_RUST_INT64_DECODE__',
    imports: ['use serde_with::DisplayFromStr;'],
    dep: { name: 'serde_with', version: '^3' },
    mode: 'lib',
  },

  'decimal': {
    encode: '__SCAFFOLD_RUST_DECIMAL_ENCODE__',
    decode: '__SCAFFOLD_RUST_DECIMAL_DECODE__',
    imports: ['use rust_decimal::Decimal;'],
    dep: { name: 'rust_decimal', version: '^1' },
    mode: 'lib',
  },

  'byte': {
    // serde_with Base64 attribute.
    encode: '__SCAFFOLD_RUST_BYTE_ENCODE__',
    decode: '__SCAFFOLD_RUST_BYTE_DECODE__',
    imports: ['use serde_with::base64::Base64;'],
    dep: { name: 'serde_with', version: '^3' },
    mode: 'lib',
  },

  'uuid': {
    encode: '__SCAFFOLD_RUST_UUID_ENCODE__',
    decode: '__SCAFFOLD_RUST_UUID_DECODE__',
    imports: ['use uuid::Uuid;'],
    dep: { name: 'uuid', version: '^1' },
    mode: 'lib',
  },

  'number-special': {
    encode: '__SCAFFOLD_RUST_NUMSPECIAL_ENCODE__',
    decode: '__SCAFFOLD_RUST_NUMSPECIAL_DECODE__',
    mode: 'native',
  },
};

// ---------------------------------------------------------------------------
// Go column (DESIGN §13.2 scaffolded — MarshalJSON/UnmarshalJSON or struct tags)
// Fully filled in `lt-host-go`.
// ---------------------------------------------------------------------------

const GO_COLUMN: LanguageTable = {
  'date-time': {
    // time.Time serialises as RFC3339Nano via MarshalJSON.
    encode: '__SCAFFOLD_GO_DATETIME_ENCODE__',
    decode: '__SCAFFOLD_GO_DATETIME_DECODE__',
    imports: ['\"time\"'],
    mode: 'native',
  },

  'int64': {
    // struct tag `json:"x,string"` or math/big for arbitrary precision.
    encode: '__SCAFFOLD_GO_INT64_ENCODE__',
    decode: '__SCAFFOLD_GO_INT64_DECODE__',
    imports: ['\"strconv\"'],
    mode: 'native',
  },

  'decimal': {
    encode: '__SCAFFOLD_GO_DECIMAL_ENCODE__',
    decode: '__SCAFFOLD_GO_DECIMAL_DECODE__',
    imports: ['\"github.com/shopspring/decimal\"'],
    dep: { name: 'github.com/shopspring/decimal', version: 'v1' },
    mode: 'lib',
  },

  'byte': {
    // encoding/base64 — stdlib.
    encode: '__SCAFFOLD_GO_BYTE_ENCODE__',
    decode: '__SCAFFOLD_GO_BYTE_DECODE__',
    imports: ['\"encoding/base64\"'],
    mode: 'native',
  },

  'uuid': {
    encode: '__SCAFFOLD_GO_UUID_ENCODE__',
    decode: '__SCAFFOLD_GO_UUID_DECODE__',
    imports: ['\"github.com/google/uuid\"'],
    dep: { name: 'github.com/google/uuid', version: 'v1' },
    mode: 'lib',
  },

  'number-special': {
    encode: '__SCAFFOLD_GO_NUMSPECIAL_ENCODE__',
    decode: '__SCAFFOLD_GO_NUMSPECIAL_DECODE__',
    mode: 'native',
  },
};

// ---------------------------------------------------------------------------
// Java column (DESIGN §13.2 scaffolded — Jackson modules + annotations)
// Fully filled in `lt-host-java`.
// ---------------------------------------------------------------------------

const JAVA_COLUMN: LanguageTable = {
  'date-time': {
    // Instant.toString() / Instant.parse() via jackson-datatype-jsr310.
    encode: '__SCAFFOLD_JAVA_DATETIME_ENCODE__',
    decode: '__SCAFFOLD_JAVA_DATETIME_DECODE__',
    imports: ['import java.time.Instant;'],
    dep: { name: 'jackson-datatype-jsr310', version: '2.x' },
    mode: 'lib',
  },

  'int64': {
    // @JsonFormat(shape=STRING) on Long / BigInteger — stdlib Jackson.
    encode: '__SCAFFOLD_JAVA_INT64_ENCODE__',
    decode: '__SCAFFOLD_JAVA_INT64_DECODE__',
    imports: ['import com.fasterxml.jackson.annotation.JsonFormat;'],
    mode: 'native',
  },

  'decimal': {
    // @JsonSerialize(using=ToStringSerializer) on BigDecimal — stdlib Jackson.
    encode: '__SCAFFOLD_JAVA_DECIMAL_ENCODE__',
    decode: '__SCAFFOLD_JAVA_DECIMAL_DECODE__',
    imports: ['import java.math.BigDecimal;'],
    mode: 'native',
  },

  'byte': {
    // byte[] serialises as base64 by default in Jackson.
    encode: '__SCAFFOLD_JAVA_BYTE_ENCODE__',
    decode: '__SCAFFOLD_JAVA_BYTE_DECODE__',
    mode: 'native',
  },

  'uuid': {
    // UUID.toString() / UUID.fromString() — stdlib Java.
    encode: '__SCAFFOLD_JAVA_UUID_ENCODE__',
    decode: '__SCAFFOLD_JAVA_UUID_DECODE__',
    imports: ['import java.util.UUID;'],
    mode: 'native',
  },

  'number-special': {
    // Custom StdSerializer — stdlib Jackson.
    encode: '__SCAFFOLD_JAVA_NUMSPECIAL_ENCODE__',
    decode: '__SCAFFOLD_JAVA_NUMSPECIAL_DECODE__',
    mode: 'native',
  },
};

// ---------------------------------------------------------------------------
// TEMPLATE_CELLS — the master registry (DESIGN §13.1 / §13.2)
// ---------------------------------------------------------------------------

/**
 * @stable The template-cell registry: `[language][logicalTypeId] → TemplateCell`.
 *
 * TypeScript and Python columns are fully filled per DESIGN §13.2 (verbatim
 * expressions).  Rust, Go, and Java columns are scaffolded — structure complete,
 * expressions use `__SCAFFOLD_*__` placeholders pending `lt-host-*` states.
 *
 * Keyed by {@link HostLanguage}, then by the canonical {@link CanonicalLogicalTypeId}.
 */
export const TEMPLATE_CELLS: Readonly<Record<HostLanguage, LanguageTable>> = Object.freeze({
  typescript: TYPESCRIPT_COLUMN,
  python:     PYTHON_COLUMN,
  rust:       RUST_COLUMN,
  go:         GO_COLUMN,
  java:       JAVA_COLUMN,
});

// ---------------------------------------------------------------------------
// Derivation helpers (DESIGN §14.1)
// ---------------------------------------------------------------------------

/**
 * @stable Return the template table for `language` from {@link TEMPLATE_CELLS}.
 *
 * This is the typed accessor the emitter uses to swap target languages —
 * identical to `TEMPLATE_CELLS[language]` but carries the return type.
 */
export function cellsFor(language: HostLanguage): LanguageTable {
  return TEMPLATE_CELLS[language];
}

/**
 * @stable Return only the cells (from `language`'s column) for the given
 * logical-type `ids`.  Useful when the emitter needs a focused sub-table.
 */
export function depsForLogicalTypes(
  ids: ReadonlyArray<string>,
  language: HostLanguage,
): Array<{ id: string; dep: { name: string; version: string } }> {
  const column = TEMPLATE_CELLS[language];
  const result: Array<{ id: string; dep: { name: string; version: string } }> = [];
  for (const id of ids) {
    const cell = column[id as CanonicalLogicalTypeId];
    if (cell?.dep) {
      result.push({ id, dep: cell.dep });
    }
  }
  return result;
}

/**
 * @stable Return the TypeScript `format → {name, version}` dep map for the
 * CANONICAL well-known scalar ids.
 *
 * Per-surface minimal-manifest guarantee (DESIGN §14.1): only logical types
 * that actually carry a `dep` entry appear in the map.  Stdlib types
 * (`date-time`, `int64`, `byte`, `uuid`, `number-special`) have no dep and
 * are absent — a surface that never uses `Decimal` never pulls `decimal.js`.
 *
 * This is the authoritative source for the inline `TS_LOGICAL_TYPE_DEP_MAP`
 * in `packages/apigen/cli/src/lib/commands/generate.ts` — import this instead.
 *
 * @returns A record keyed by canonical logical-type id (= JSON-Schema `format`).
 */
export function tsDepMap(): Readonly<Record<string, { name: string; version: string }>> {
  const column = TEMPLATE_CELLS.typescript;
  const out: Record<string, { name: string; version: string }> = {};
  for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
    const dep = column[id].dep;
    if (dep) out[id] = dep;
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Completeness assertion (DESIGN §13.3)
// ---------------------------------------------------------------------------

/**
 * @stable Completeness guard: assert that every canonical logical-type id has
 * a cell in `language`'s column of {@link TEMPLATE_CELLS}.
 *
 * This is the programmatic form of §13.3 ("no empty cells"). Throws if any
 * canonical id is missing — enforces: add a logical type → every declared
 * language column must fill it or this guard fires.
 *
 * @throws {Error} With the missing ids listed, if any canonical id lacks a cell.
 */
export function assertNoEmptyCells(language: HostLanguage): void {
  const column = TEMPLATE_CELLS[language];
  const missing: string[] = [];
  for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
    if (!column[id as CanonicalLogicalTypeId]) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[hints] assertNoEmptyCells: language "${language}" is missing cells for: ${missing.join(', ')}`,
    );
  }
}
