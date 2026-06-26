/**
 * @stable TypeScript HostBinding (DESIGN.md §4.6).
 *
 * A single frozen object that maps every well-known `LogicalTypeId` to its
 * TypeScript `LogicalTypeCodec`, plus representative nominal and union codecs
 * for the `nominal` / `union` kinds. This is the TS row of the cross-host
 * binding table described in DESIGN.md §4.6.
 *
 * Well-known scalar ids covered (DESIGN §3):
 *   date-time, int64, decimal, byte, uuid, number-special
 *
 * Extension kinds covered:
 *   nominal — via `createNominalCodec` (DESIGN §4.4 / §4 Phase 4)
 *   union   — via `createUnionCodec`   (DESIGN §4.4 / §4 Phase 4)
 */

import type {
  LogicalTypeCodec,
  LogicalTypeId,
} from '@adhd/apigen-logical';
import {
  LOGICAL_TYPE_VERSION,
  dateTimeCodec,
  int64Codec,
  decimalCodec,
  byteCodec,
  uuidCodec,
  numberSpecialCodec,
} from '@adhd/apigen-logical';
import { createNominalCodec } from './nominal-codec';
import { createUnionCodec } from './union-codec';

// ---------------------------------------------------------------------------
// HostBinding interface — DESIGN.md §4.6
// (Not yet in @adhd/apigen-logical; defined here matching the spec exactly.)
// ---------------------------------------------------------------------------

/**
 * @stable A host binding maps a LogicalTypeId to that host's native
 * encode/decode primitives (DESIGN.md §4.6).
 *
 * - `host`               — identifies the language/runtime.
 * - `logicalTypeVersion` — pinned to `LOGICAL_TYPE_VERSION` from
 *                          `@adhd/apigen-logical`; bumped on any wire-table
 *                          or pinned-lib-version change (DESIGN §8.6).
 * - `codecs`             — frozen ReadonlyMap keyed by LogicalTypeId. Must
 *                          cover every well-known id (DESIGN §4.6 "Must cover
 *                          every well-known id.").
 */
export interface HostBinding {
  readonly host: 'ts' | 'python' | 'rust' | 'go' | 'java';
  readonly logicalTypeVersion: string;
  /** The codecs this host provides, keyed by LogicalTypeId. */
  readonly codecs: ReadonlyMap<LogicalTypeId, LogicalTypeCodec>;
}

// ---------------------------------------------------------------------------
// Canonical well-known scalar codecs as a flat list — the single source
// of truth for coverage assertions in tests and the binding below.
// ---------------------------------------------------------------------------

/**
 * @stable Ordered array of all well-known scalar codec instances for the TS
 * host. Derived from the same import list used by `registerWellKnown` in
 * `@adhd/apigen-logical`; kept in sync by importing the exact same named
 * exports (a future addition to that barrel automatically lands here).
 */
export const WELL_KNOWN_TS_CODECS: ReadonlyArray<LogicalTypeCodec> = [
  dateTimeCodec,
  int64Codec,
  decimalCodec,
  byteCodec,
  uuidCodec,
  numberSpecialCodec,
] as const;

// ---------------------------------------------------------------------------
// Canonical placeholder schemas for the nominal + union extension codecs.
//
// The nominal and union codecs are factories (they bind to a specific class /
// union schema). The TS host binding includes *sentinel* instances of each
// kind so the binding table satisfies "every well-known kind is represented"
// and consumers can discover the factory via `.kind`. Real class- and
// union-specific codecs are created by the code generator and registered on a
// per-surface registry — they are NOT stored in this global binding.
// ---------------------------------------------------------------------------

/**
 * Sentinel nominal-kind codec included in the binding to prove the `nominal`
 * kind is covered. A generated surface creates its own instance via
 * `createNominalCodec({ id: '<ns>.<Class>', schema, ctor })`.
 */
const NOMINAL_SENTINEL_SCHEMA = {
  type: 'object',
  'x-apigen-logical': 'nominal',
  'x-apigen-codec': 'ts.NominalSentinel',
} as const;

const nominalSentinelCodec = createNominalCodec({
  id: 'ts.NominalSentinel',
  schema: NOMINAL_SENTINEL_SCHEMA,
});

/**
 * Sentinel union-kind codec included in the binding to prove the `union` kind
 * is covered. A generated surface creates its own instance via
 * `createUnionCodec({ id: '<ns>.<Union>', schema })`.
 */
const UNION_SENTINEL_SCHEMA = {
  oneOf: [],
  discriminator: { propertyName: 'kind', mapping: {} },
  'x-apigen-logical': 'union',
  'x-apigen-codec': 'ts.UnionSentinel',
} as const;

const unionSentinelCodec = createUnionCodec({
  id: 'ts.UnionSentinel',
  schema: UNION_SENTINEL_SCHEMA,
});

// ---------------------------------------------------------------------------
// Build the frozen codec map
// ---------------------------------------------------------------------------

function buildCodecMap(): ReadonlyMap<LogicalTypeId, LogicalTypeCodec> {
  const entries: Array<[LogicalTypeId, LogicalTypeCodec]> = [
    // 6 well-known scalars
    ...WELL_KNOWN_TS_CODECS.map((c): [LogicalTypeId, LogicalTypeCodec] => [c.id, c]),
    // nominal kind sentinel
    [nominalSentinelCodec.id, nominalSentinelCodec],
    // union kind sentinel
    [unionSentinelCodec.id, unionSentinelCodec],
  ];
  return Object.freeze(new Map(entries));
}

// ---------------------------------------------------------------------------
// The exported binding
// ---------------------------------------------------------------------------

/**
 * @stable The TypeScript HostBinding (DESIGN.md §4.6).
 *
 * A frozen object exposing all TS codec instances keyed by their
 * `LogicalTypeId`. Consumers obtain a per-surface registry by calling
 * `registerWellKnown(registry)` from `@adhd/apigen-logical`, then
 * registering the generated nominal/union codecs on top.
 *
 * `logicalTypeVersion` is pinned to `LOGICAL_TYPE_VERSION` exported by
 * `@adhd/apigen-logical` (`descriptor-ext.ts`) — `'0.1.0'` at authoring time.
 * Any wire-table or pinned-lib-version change bumps that constant and this
 * binding automatically reflects the new version.
 */
export const tsHostBinding: HostBinding = Object.freeze({
  host: 'ts' as const,
  logicalTypeVersion: LOGICAL_TYPE_VERSION,
  codecs: buildCodecMap(),
});
