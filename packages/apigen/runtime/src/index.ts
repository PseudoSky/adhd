export { defineMiddleware } from './lib/define-middleware'
export { EventBus, wireObservers } from './lib/event-bus'
export { buildContext } from './lib/build-context'
export { assertNoSelfSubscription, createApiPackage } from './lib/api-package'
export type {
  MiddlewareDef,
  MiddlewareEvent,
  ApiPackageOptions,
  ApiPackageResult,
  ConfigurationError,
  GeneratedSchemas,
  ComposedSchemas,
} from './lib/types'
// Note: dispatch utilities come from runtime-dispatch state
