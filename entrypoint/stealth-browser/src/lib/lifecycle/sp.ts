/**
 * @adhd/stealth-browser — src/lib/lifecycle/sp.ts
 *
 * The ONLY import site of the service-proxy transport. Every lifecycle module
 * reaches it through this file, so the dependency surface is auditable in one
 * place and the unit lane mocks the package once (`vi.mock` of the package).
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.1, CL22).
 */

export {
  ensureBackend,
  serveBackend,
  dialBackend,
  backendSocketPath,
  ensurePrivateSocketDir,
  readProcessStartToken,
  isSameProcess,
  createIdleRetirer,
  createCircuitBreaker,
  isUdsDirUnsafeError,
  ERR_BACKEND_UNAVAILABLE,
} from '@adhd/sox-service-proxy'

export type {
  BackendConnection,
  BackendHandle,
  BackendHandler,
  BreakerState,
  BreakerStore,
  CircuitBreaker,
  ClientDisconnectReason,
  ConnectionContext,
  EnsureBackendResult,
  IdleRetirer,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@adhd/sox-service-proxy'
