/**
 * @stable Well-known scalar codec barrel for `@adhd/apigen-logical`.
 *
 * Exports every built-in `LogicalTypeCodec` and the `registerWellKnown`
 * helper that loads them all into a registry in canonical order.
 *
 * Canonical id → codec mapping (DESIGN §3):
 *   date-time      → dateTimeCodec      ({type:'string', format:'date-time'})
 *   int64          → int64Codec         ({type:'string', format:'int64'})
 *   decimal        → decimalCodec       ({type:'string', format:'decimal'})
 *   byte           → byteCodec          ({type:'string', format:'byte'})
 *   uuid           → uuidCodec          ({type:'string', format:'uuid'})
 *   number-special → numberSpecialCodec ({type:'number'})
 */

import type { LogicalTypeRegistry } from '../registry';
import { dateTimeCodec } from './date-time';
import { int64Codec } from './int64';
import { decimalCodec } from './decimal';
import { byteCodec } from './byte';
import { uuidCodec } from './uuid';
import { numberSpecialCodec } from './number-special';

export { dateTimeCodec } from './date-time';
export type { } from './date-time';           // re-export side carries the file for tree-shaking
export { int64Codec } from './int64';
export { decimalCodec, makeDecimal } from './decimal';
export type { DecimalString } from './decimal';
export { byteCodec } from './byte';
export { uuidCodec } from './uuid';
export { numberSpecialCodec } from './number-special';

/** Ordered list of all well-known scalar codecs (DESIGN §3). */
const WELL_KNOWN_CODECS = [
  dateTimeCodec,
  int64Codec,
  decimalCodec,
  byteCodec,
  uuidCodec,
  numberSpecialCodec,
] as const;

/**
 * @stable Register all well-known scalar codecs into `registry`.
 *
 * Idempotent when called with `{override:true}` — subsequent calls replace
 * existing registrations without throwing. Useful in test setups that
 * reconstruct a registry per test.
 *
 * @param registry - The target registry (mutable — must not be frozen).
 * @param opts.override - When `true`, re-registration does not throw
 *   `E_DUP_CODEC`. Default: `false`.
 */
export function registerWellKnown(
  registry: LogicalTypeRegistry,
  opts: { override?: boolean } = {},
): void {
  for (const codec of WELL_KNOWN_CODECS) {
    registry.register(codec, { override: opts.override ?? false });
  }
}
