/**
 * The ONLY module here that statically imports the extractor. It is reached
 * exclusively through a dynamic `import('./ir-live')` from `ir.ts`, so the
 * baked-artifact startup path never loads it (mirrors
 * `entrypoint/backlog/src/extract-live.ts`).
 */
import { extract, type ExtractOptions, type Operation } from '@adhd/apigen-core-client';

/** Namespace every policy operation is extracted under (`policy/check`, ...). */
export const POLICY_EXTRACT_NAMESPACE = 'policy';

/**
 * The single source of the extraction options, used by both the bake step and
 * the live fallback so the two can never produce different surfaces.
 * `dropFileSegment` keeps the source file's basename (`api`) out of every
 * command name.
 */
export function buildPolicyExtractOptions(apiDts: string): ExtractOptions {
  return { sourceFile: apiDts, namespace: POLICY_EXTRACT_NAMESPACE, dropFileSegment: true };
}

/** Extracts the operations of the client's `service/api.d.ts`. */
export async function extractPolicyOperationsLive(apiDts: string): Promise<Operation[]> {
  return extract(buildPolicyExtractOptions(apiDts));
}
