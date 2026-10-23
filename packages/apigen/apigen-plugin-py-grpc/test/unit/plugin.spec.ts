/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `plugin.e2e.ts`.
 *
 * Resource lane: proc — it spawns a real managed Python interpreter per block
 * (a live gRPC server on an OS-assigned port, driven by the external
 * `grpcurl` binary), plus a real `node`/`npx` subprocess for the
 * negative-control gate.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `plugin.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: py-grpc plugin', () => {
  // [LIVE gRPC server] — describe.skip in the e2e lane (CPU-THRASH-SKIP).
  it.todo('mocked: grpcurl list → the project()-derived service appears');
  it.todo('mocked: grpcurl describe → project()-derived methods AddDecimal, Greet listed');
  it.todo('mocked: [decimal] add_decimal "123.456" → "123.457" exact decimal string');
  it.todo('mocked: [decimal] add_decimal "0.1" → "0.101" (float would give 0.10100000...001)');
  it.todo('mocked: [string] greet "World" → "Hello, World!" plain string round-trip');
  it.todo('mocked: [envelope] x-adhd-session metadata forwarded to ctx parameter');
  it.todo('mocked: [validation] calling add_decimal without amount → gRPC error (non-zero exit)');
  it.todo('mocked: [reflection] grpcurl describe returns typed Data sub-message');
  // [naming reconciliation] with project()
  it.todo('mocked: project(): add_decimal → package "pkg.grpc_api", service "GrpcApi", method "AddDecimal"');
  it.todo('mocked: project(): greet_with_ctx → method "GreetWithCtx" (multi-word Pascal-cased)');
  it.todo('mocked: LIVE: the server answers at the project()-derived address, and the OLD divergent address is now UNIMPLEMENTED');
  // [fix:pygrpc-streaming-deferral]
  it.todo('mocked: a streaming:true operation makes the server exit non-zero with a clear error, never silently unary-dispatched');
  // [py-grpc-serve-split] parity gate
  it.todo('mocked: recapture deep-equals the committed golden snapshot');
  it.todo('mocked: applying neg-control/py-grpc-serve-split.patch turns the golden-parity check RED; reverting turns it GREEN');
  // [BUG-APIGEN-053] parent-death watchdog
  it.todo('mocked: a Python host survives its own spawning process being SIGKILLed, then self-terminates within a bounded deadline (poll, never sleep)');
  it.todo('mocked: a Python host torn down gracefully (normal suite path) also disappears within the same bounded deadline, proven by PID poll');
});
