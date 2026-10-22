/**
 * The ONLY module here that statically imports the extractor. It is reached
 * exclusively through a dynamic `import('./ir-live')` from `ir.ts`, so the
 * baked-artifact startup path never loads it (mirrors
 * `entrypoint/backlog/src/extract-live.ts`).
 *
 * Both the live fallback and the build-time bake turn the client's
 * `service/api.d.ts` into operations through the ONE core-client
 * IR-generation entry (`extractSourceEntry`, adhd ADR-0017 D5), and the bake
 * shapes its output with the ir-cache artifact target (`buildIrCacheArtifact`),
 * so the artifact `entrypoint/policy` ships is the artifact the cache stores.
 */
import { statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import {
  createExtractorRegistry,
  extractSourceEntry,
  resolveSourceReference,
  type Descriptor,
  type Operation,
} from '@adhd/apigen-core-client';
import { atomicWriteJson, buildIrCacheArtifact, type CachedExtractEntry } from '@adhd/apigen-plugin-ir-cache';
import { POLICY_IR_ARTIFACT_FILENAME, surfaceDepHashes, type IClientApi } from './ir';

/** Namespace every policy operation is extracted under (`policy/check`, ...). */
export const POLICY_EXTRACT_NAMESPACE = 'policy';

/**
 * Extracts the operations of the client's `service/api.d.ts` through the
 * core-client entry. `dropFileSegment` keeps the source file's basename (`api`)
 * out of every command name. The bake and the live fallback both call this, so
 * the two can never produce different surfaces.
 */
export async function extractPolicyOperationsLive(apiDts: string): Promise<Operation[]> {
  const resolved = resolveSourceReference(apiDts);
  if (!resolved.ok) throw new Error(`@adhd/policy: cannot resolve the client declarations ${apiDts}: ${resolved.error.message}`);
  const { operations } = await extractSourceEntry({
    reference: apiDts,
    resolution: resolved.value,
    namespace: POLICY_EXTRACT_NAMESPACE,
    dropFileSegment: true,
    usePlugins: [],
    extractLayerOptions: {},
    registry: createExtractorRegistry(),
  });
  return operations;
}

/**
 * Bakes the artifact to `outFile` (atomically): the operations from
 * {@link extractPolicyOperationsLive} wrapped by the ir-cache artifact target's
 * `CachedExtractEntry`, plus `artifactSource` provenance - the `.d.ts` surface
 * digests the reader re-checks so a drifted client never serves a stale surface.
 */
export async function bakePolicyIr(outFile: string, client: IClientApi, extractorVersion: string): Promise<void> {
  const operations = await extractPolicyOperationsLive(client.apiDts);
  const descriptor = { operations, host: 'ts', namespace: POLICY_EXTRACT_NAMESPACE } as Descriptor;
  const [file] = buildIrCacheArtifact(descriptor, { cache: 'artifact', filename: POLICY_IR_ARTIFACT_FILENAME, extractorVersion });
  if (file === undefined) throw new Error('@adhd/policy: the ir-cache artifact target emitted no file.');
  const entry = JSON.parse(String(file.content)) as CachedExtractEntry;
  const deps = surfaceDepHashes(client.surfaceRoot);
  const apiKey = relative(client.surfaceRoot, client.apiDts).split(sep).join('/');
  const apiSha = deps[apiKey];
  if (apiSha === undefined) throw new Error(`@adhd/policy: ${client.apiDts} is not under the declaration root ${client.surfaceRoot}.`);
  await atomicWriteJson(outFile, { ...entry, artifactSource: { path: apiKey, sha256: apiSha, bytes: statSync(client.apiDts).size, deps } });
}
