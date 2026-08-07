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
  dateTimeCodec.id, // 'date-time'
  int64Codec.id, // 'int64'
  decimalCodec.id, // 'decimal'
  byteCodec.id, // 'byte'
  uuidCodec.id, // 'uuid'
  numberSpecialCodec.id, // 'number-special'
] as const satisfies ReadonlyArray<string>;

/** @stable Union of the canonical well-known scalar ids. */
export type CanonicalLogicalTypeId =
  (typeof CANONICAL_LOGICAL_TYPE_IDS)[number];

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
 * {@link TEMPLATE_CELLS}.  `'typescript'`, `'python'`, and `'java'` (FEAT-APIGEN-001
 * slice 1/3, 2026-08-06) are fully filled (§13.2 values verbatim / real
 * Jackson expressions — see the `JAVA_COLUMN` doc comments below).
 * `'rust'` and `'go'` remain scaffolded — structure complete, expressions
 * use stable placeholders pending the `lt-host-*` states.
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

  int64: {
    encode: 'String($)',
    decode: 'BigInt($)',
    mode: 'native',
  },

  decimal: {
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

  byte: {
    encode: "Buffer.from($).toString('base64')",
    decode: "new Uint8Array(Buffer.from($, 'base64'))",
    mode: 'native',
  },

  uuid: {
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

  int64: {
    encode: 'str($)',
    decode: 'int($)',
    mode: 'native',
  },

  decimal: {
    encode: 'str($)',
    decode: 'Decimal($)',
    imports: ['from decimal import Decimal'],
    mode: 'native',
  },

  byte: {
    encode: 'b64encode($).decode()',
    decode: 'b64decode($)',
    imports: ['from base64 import b64encode, b64decode'],
    mode: 'native',
  },

  uuid: {
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

  int64: {
    // serde_with DisplayFromStr for i64/u64.
    encode: '__SCAFFOLD_RUST_INT64_ENCODE__',
    decode: '__SCAFFOLD_RUST_INT64_DECODE__',
    imports: ['use serde_with::DisplayFromStr;'],
    dep: { name: 'serde_with', version: '^3' },
    mode: 'lib',
  },

  decimal: {
    encode: '__SCAFFOLD_RUST_DECIMAL_ENCODE__',
    decode: '__SCAFFOLD_RUST_DECIMAL_DECODE__',
    imports: ['use rust_decimal::Decimal;'],
    dep: { name: 'rust_decimal', version: '^1' },
    mode: 'lib',
  },

  byte: {
    // serde_with Base64 attribute.
    encode: '__SCAFFOLD_RUST_BYTE_ENCODE__',
    decode: '__SCAFFOLD_RUST_BYTE_DECODE__',
    imports: ['use serde_with::base64::Base64;'],
    dep: { name: 'serde_with', version: '^3' },
    mode: 'lib',
  },

  uuid: {
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
    imports: ['"time"'],
    mode: 'native',
  },

  int64: {
    // struct tag `json:"x,string"` or math/big for arbitrary precision.
    encode: '__SCAFFOLD_GO_INT64_ENCODE__',
    decode: '__SCAFFOLD_GO_INT64_DECODE__',
    imports: ['"strconv"'],
    mode: 'native',
  },

  decimal: {
    encode: '__SCAFFOLD_GO_DECIMAL_ENCODE__',
    decode: '__SCAFFOLD_GO_DECIMAL_DECODE__',
    imports: ['"github.com/shopspring/decimal"'],
    dep: { name: 'github.com/shopspring/decimal', version: 'v1' },
    mode: 'lib',
  },

  byte: {
    // encoding/base64 — stdlib.
    encode: '__SCAFFOLD_GO_BYTE_ENCODE__',
    decode: '__SCAFFOLD_GO_BYTE_DECODE__',
    imports: ['"encoding/base64"'],
    mode: 'native',
  },

  uuid: {
    encode: '__SCAFFOLD_GO_UUID_ENCODE__',
    decode: '__SCAFFOLD_GO_UUID_DECODE__',
    imports: ['"github.com/google/uuid"'],
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
    // Instant.toString() (RFC-3339/ISO-8601, UTC) / Instant.parse($) — the
    // jackson-datatype-jsr310 module is registered on the shared ObjectMapper
    // so java.time.Instant fields round-trip automatically, but the
    // dispatcher-woven glue (which builds/reads JsonNode by hand rather than
    // going through a field-annotated POJO) uses these expressions directly.
    encode: '$.toString()',
    decode: 'Instant.parse($)',
    imports: ['import java.time.Instant;'],
    dep: { name: 'jackson-datatype-jsr310', version: '2.x' },
    mode: 'lib',
  },

  int64: {
    // Declarative, not expression-shaped: Jackson field annotation forces
    // Long/long to serialise as a JSON string (avoids precision loss in
    // JS/JSON-number consumers). mode:'native' — the "encode"/"decode"
    // values below ARE the annotation text (identical on both sides; Jackson
    // applies it symmetrically), not a `$`-substituted call expression.
    encode: '@JsonFormat(shape = JsonFormat.Shape.STRING)',
    decode: '@JsonFormat(shape = JsonFormat.Shape.STRING)',
    imports: ['import com.fasterxml.jackson.annotation.JsonFormat;'],
    mode: 'native',
  },

  decimal: {
    // Encode is declarative (field annotation forces BigDecimal -> JSON
    // string via Jackson's stdlib ToStringSerializer, so scale/precision
    // survive the wire); decode is a plain expression since BigDecimal has
    // no matching stdlib deserializer-by-annotation for "parse from string".
    encode: '@JsonSerialize(using = ToStringSerializer.class)',
    decode: 'new BigDecimal($)',
    imports: [
      'import java.math.BigDecimal;',
      'import com.fasterxml.jackson.databind.annotation.JsonSerialize;',
      'import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;',
    ],
    mode: 'native',
  },

  byte: {
    // byte[] <-> base64 String is Jackson's built-in default codec — no
    // annotation, no wrapping expression. The dispatcher glue passes the
    // value through unchanged; Jackson's ObjectMapper performs the base64
    // transcoding when the JsonNode tree is built/read.
    encode: '$',
    decode: '$',
    mode: 'native',
  },

  uuid: {
    // UUID.toString() / UUID.fromString($) — stdlib Java, no Jackson module.
    encode: '$.toString()',
    decode: 'UUID.fromString($)',
    imports: ['import java.util.UUID;'],
    mode: 'native',
  },

  'number-special': {
    // NaN/Infinity/-Infinity have no native JSON representation; mirrors the
    // TS numToWire/wireToNum inline helpers with a small custom Jackson
    // StdSerializer/StdDeserializer pair, generated inline by
    // renderDispatcherJava (class names below are the fixed contract the
    // generator emits — apigen-plugin-java-javalin/src/lib/dispatcher-template.ts).
    encode: '@JsonSerialize(using = NumberSpecialSerializer.class)',
    decode: '@JsonDeserialize(using = NumberSpecialDeserializer.class)',
    imports: [
      'import com.fasterxml.jackson.databind.annotation.JsonSerialize;',
      'import com.fasterxml.jackson.databind.annotation.JsonDeserialize;',
    ],
    mode: 'native',
  },
};

// ---------------------------------------------------------------------------
// TEMPLATE_CELLS — the master registry (DESIGN §13.1 / §13.2)
// ---------------------------------------------------------------------------

/**
 * @stable The template-cell registry: `[language][logicalTypeId] → TemplateCell`.
 *
 * TypeScript, Python, and Java columns are fully filled (TypeScript/Python
 * per DESIGN §13.2 verbatim expressions; Java per FEAT-APIGEN-001 slice 1/3 —
 * real Jackson annotation/expression glue, no `__SCAFFOLD_*__` left — see
 * `JAVA_COLUMN` above). Rust and Go columns remain scaffolded — structure
 * complete, expressions use `__SCAFFOLD_*__` placeholders pending `lt-host-*`
 * states.
 *
 * Keyed by {@link HostLanguage}, then by the canonical {@link CanonicalLogicalTypeId}.
 */
export const TEMPLATE_CELLS: Readonly<Record<HostLanguage, LanguageTable>> =
  Object.freeze({
    typescript: TYPESCRIPT_COLUMN,
    python: PYTHON_COLUMN,
    rust: RUST_COLUMN,
    go: GO_COLUMN,
    java: JAVA_COLUMN,
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
  language: HostLanguage
): Array<{ id: string; dep: { name: string; version: string } }> {
  const column = TEMPLATE_CELLS[language];
  const result: Array<{ id: string; dep: { name: string; version: string } }> =
    [];
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
export function tsDepMap(): Readonly<
  Record<string, { name: string; version: string }>
> {
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
 * The optional `_tableOverride` parameter exists ONLY for test injection
 * (DEBT-LT-007): it lets a test drive the production throw path against a
 * simulated incomplete column WITHOUT monkey-patching the frozen TEMPLATE_CELLS.
 * Production callers must never pass it — the default (reading from
 * TEMPLATE_CELLS) is always correct for production use.
 *
 * @throws {Error} With the missing ids listed, if any canonical id lacks a cell.
 */
export function assertNoEmptyCells(
  language: HostLanguage,
  _tableOverride?: Partial<LanguageTable>
): void {
  const column: Partial<LanguageTable> =
    _tableOverride ?? TEMPLATE_CELLS[language];
  const missing: string[] = [];
  for (const id of CANONICAL_LOGICAL_TYPE_IDS) {
    if (!column[id as CanonicalLogicalTypeId]) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[hints] assertNoEmptyCells: language "${language}" is missing cells for: ${missing.join(
        ', '
      )}`
    );
  }
}
