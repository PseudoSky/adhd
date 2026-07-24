export { createInvoker, LayerContext } from './lib/invoke';
export type {
  Layer,
  LayerResult,
  Next,
  Call,
  InvokeOptions,
  InvokeFn,
} from './lib/invoke';
export { defineMiddleware } from './lib/define-middleware';
export { EventBus, wireObservers } from './lib/event-bus';
export { buildContext } from './lib/build-context';
export { assertNoSelfSubscription, createApiPackage } from './lib/api-package';
export type {
  MiddlewareDef,
  MiddlewareEvent,
  ApiPackageOptions,
  ApiPackageResult,
  ConfigurationError,
  GeneratedSchemas,
  ComposedSchemas,
} from './lib/types';
export { needsEnvelopeField, dataParamNames, dispatch } from './lib/dispatch';
export { createLogger } from './lib/logger';
export type { Logger, LogFormat, CreateLoggerOptions } from './lib/logger';
export { describeParams } from './lib/describe-params';
export type { ParamInfo } from './lib/describe-params';
export { coerceQueryParams } from './lib/coerce-query';
export { buildFnTable } from './lib/fn-table';
export type { AnyFn } from './lib/fn-table';
export {
  validateLayer,
  makeValidateLayer,
  ValidateSchemasToken,
} from './lib/validate-layer';
export { InstanceRegistry } from './lib/instance-registry';
export type {
  InstanceRegistryOptions,
  CreateResult,
  AnyConstructor,
} from './lib/instance-registry';
export {
  createStream,
  drainStream,
  collectWithPhase,
  isApiStream,
} from './lib/stream';
export type {
  ApiStream,
  CreateStreamOptions,
  CollectResult,
} from './lib/stream';
export { createUnionCodec, UnionCodecError } from './lib/logical/union-codec';
export type {
  UnionCodecOptions,
  UnionCodecErrorCode,
} from './lib/logical/union-codec';
export { tsHostBinding, WELL_KNOWN_TS_CODECS } from './lib/logical/host-ts';
export type { HostBinding } from './lib/logical/host-ts';
export { buildToolDescription } from './lib/tool-description';
export type { ToolDescriptionSchema } from './lib/tool-description';
export {
  buildMcpOutputSchema,
  wrapMcpStructuredContent,
} from './lib/mcp-output-schema';
export type { McpOutputAdapter } from './lib/mcp-output-schema';

// ---------------------------------------------------------------------------
// serve-core primitives ([iface:op-plan], [iface:transport-adapter],
// [iface:create-package-invoker], [iface:dispatch-for-plan]) — transport-
// neutral OpPlan resolution + the TransportAdapter port. No transport
// consumes these yet; the fastify/express/mcp/cli/py-* adapter states
// migrate onto them (and DELETE their duplicated equivalents) later.
// ---------------------------------------------------------------------------
export { buildOpPlan } from './lib/op-plan';
export type {
  OpPlan,
  BuildOpPlanInput,
  OpPlanEnvelopeField,
  OpPlanCliFlag,
} from './lib/op-plan';
export type { TransportAdapter } from './lib/transport-adapter';
export {
  createPackageInvoker,
  readUsePlugins,
  readUseOptions,
  adaptCoreLayer,
} from './lib/package-invoker';
export type { UsePlugin, UseOptions } from './lib/package-invoker';
export { dispatchForPlan } from './lib/dispatch-for-plan';
