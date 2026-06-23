export const __apigen_pkg = '@adhd/apigen-gateway';

// SPEC §13 / §13.1 — the sidecar gateway public API.
export {
  // Factory + surface
  createGateway,
  type Gateway,
  type GatewayOptions,
  type GatewayHealth,
  type HostHealth,
  type HostStatus,
  // Host-adapter boundary (the §14.4 integration seam)
  type HostAdapter,
  type HostRequest,
  type InProcessRuntime,
  createInProcessHostAdapter,
  // Supervision
  type BackoffPolicy,
  defaultBackoff,
  // §13.1 error model
  GATEWAY_ERROR_CODES,
  type GatewayErrorCode,
  GATEWAY_HTTP_STATUS,
  GATEWAY_GRPC_CODE,
  type GatewayErrorDetail,
  makeUnavailableError,
  makeDeadlineExceededError,
  isGatewayError,
} from './lib/gateway';
