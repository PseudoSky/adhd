/**
 * Consumer-supplied ports (types only; no implementation ships, SC-03).
 */
import type { ILayerInput, Attributes, IRuntimeValues } from './policy';
import type { IAuditEntry } from './results';

/** Records a call and returns the post-observation runtime values atomically (RT-08). */
export interface IRuntimeProvider {
  /**
   * `scope` is a consumer-chosen opaque key (a session id, a token subject, anything).
   * Safe across processes only if the provider makes it so (RT-07).
   */
  observe(input: { scope?: string; tool: string; attributes: Attributes }): Promise<IRuntimeValues>;
}

/** Receives one redacted record per decision (AU-01). */
export interface IAuditSink {
  record(entry: IAuditEntry): void;
}

/** Returns the existing layers in global, project, local order, parsed to JSON. */
export interface ILayerSource {
  load(): Promise<readonly ILayerInput[]>;
}
