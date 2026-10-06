/**
 * production-gate.ts — S02 AC14 / cluster `backlog-lifecycle-model`
 * (`0b0df8f3`): the explicit production-write gate.
 *
 * The store the backlog CLI opens by default is the LIVE machine-wide
 * production store (`~/.adhd/backlog/production/…`, scope `global`). A probe
 * that drives the real bin, or any automated caller, therefore writes into the
 * store of record by accident — the contamination class RSD-18
 * (`76a2d61a`) tracks, and the only remedy today is a soft-delete that leaves a
 * permanent tombstone. This gate makes that write FAIL LOUDLY unless the caller
 * passes an explicit TYPED opt-in.
 *
 * ## Why a typed gate, not an env toggle
 *
 * RSD-18's own Definition of Done: "a typed CLI flag / typed config — never an
 * env toggle, ADR-0013". An env var is silently inherited by every child
 * process, so a gate keyed on one is exactly the "looks like isolation but
 * isn't" trap. The gate travels with the request: `allowProductionWrite` is a
 * boolean on the caller's input, threaded onto the write handle by the
 * transport that resolved the store.
 *
 * ## Inertness (the safety property)
 *
 * `IProductionWriteGate` is OPTIONAL on `IWriteStoreHandle`. A handle that does
 * not carry one — every direct-store caller (tests, the ETL, the library
 * surface) and every ISOLATED transport (`--namespace sandbox`/`test`, a
 * redirected `ADHD_ROOT`/`ADHD_BACKLOG_DATABASE_PATH`, a non-`global` scope) —
 * is NOT gated at all. Only a transport that has positively established
 * `isProductionStore: true` is subject to the refusal. That keeps the gate
 * surgical: it protects the one store that matters and cannot fail open into a
 * domain-write outage.
 */
import { ProductionWriteRefusedError } from './errors.js';

/**
 * The production-store description a transport attaches to a write handle.
 * `isProductionStore` is computed by the transport that resolved the store
 * (cli.ts / server.ts) from the SAME signals that distinguish an isolated run
 * (namespace, scope, explicit root/db overrides) — never inferred here.
 */
export interface IProductionWriteGate {
  /** `true` iff the resolved store is the LIVE production store (`global` scope + `production` namespace, no isolation override). */
  readonly isProductionStore: boolean;
  /** The explicit typed opt-in. ONLY an explicit `true` opens the gate; absent/false both refuse. */
  readonly allowProductionWrite: boolean;
}

/**
 * The one gate check every write transaction runs. No-op unless the handle
 * positively declares a production store AND the explicit opt-in is absent.
 *
 * @throws ProductionWriteRefusedError — before any transaction is opened, so a
 *   refused write has NO side effect and is never retried.
 */
export function assertProductionWriteAllowed(
  handle: { readonly productionWrite?: IProductionWriteGate },
  verb: string
): void {
  const gate = handle.productionWrite;
  if (gate?.isProductionStore === true && gate.allowProductionWrite !== true) {
    throw new ProductionWriteRefusedError(verb);
  }
}
