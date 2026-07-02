// @adhd/apigen-logical — the contract spine for schema-driven, registry-based
// cross-host logical-type transcoding (DESIGN.md §4/§5/§13). Interfaces only at
// this state: the codec contract, the registry, the descriptor extension
// vocabulary, and the (not-yet-implemented) transcoder interface.

export type {
  LogicalTypeId,
  LogicalKind,
  Wire,
  SchemaNode,
  TranscodeCtx,
  LogicalTypeCodec,
  TemplateCell,
  ApigenEnvelope,
  Transcoder,
} from './lib/contracts';
export { ENVELOPE_KEY } from './lib/contracts';

export type { LogicalTypeRegistry } from './lib/registry';
export { createRegistry, CodecRegistryError } from './lib/registry';

export {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
  LOGICAL_TYPE_VERSION,
  logicalKindOf,
  codecIdOf,
} from './lib/descriptor-ext';

export { buildTranscoder, tryRegister } from './lib/runmode';

export {
  dateTimeCodec,
  int64Codec,
  decimalCodec,
  makeDecimal,
  byteCodec,
  uuidCodec,
  numberSpecialCodec,
  registerWellKnown,
} from './lib/codecs/index';
export type { DecimalString } from './lib/codecs/index';

// Template-cell registry (DESIGN §13.1–§13.3, §14.1)
export {
  CANONICAL_LOGICAL_TYPE_IDS,
  TEMPLATE_CELLS,
  cellsFor,
  depsForLogicalTypes,
  tsDepMap,
  assertNoEmptyCells,
} from './lib/hints';
export type {
  CanonicalLogicalTypeId,
  HostLanguage,
  LanguageTable,
} from './lib/hints';
