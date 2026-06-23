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
