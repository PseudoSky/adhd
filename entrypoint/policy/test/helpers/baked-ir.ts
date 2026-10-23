import { readFile } from 'node:fs/promises';
import type { Operation } from '@adhd/apigen-core-client';
import { bakedIrArtifactPath, policyDistDir } from '../../src/wrapper/ir';

/**
 * The text of the artifact the build shipped in `dist/` (the output of the one live extraction the build runs).
 * Unit specs start from it instead of re-running the ts-morph extraction (seconds per run), which only the e2e lane
 * re-runs (`t-r12-ir-artifact.e2e.ts`). Throws (red) when the build did not produce `dist/api.ir.json`.
 */
export async function shippedBakedIrText(): Promise<string> {
  return await readFile(bakedIrArtifactPath(policyDistDir()), 'utf8');
}

/** The operations held by the shipped artifact: what a live extraction of the same declarations produces (proved equal in the e2e lane). */
export async function shippedOperations(): Promise<Operation[]> {
  return (JSON.parse(await shippedBakedIrText()) as { operations: Operation[] }).operations;
}

/**
 * Body for `vi.mock('../../wrapper/ir-live', ...)`: the extractor module with the real extraction replaced by the
 * shipped artifact's operations, so a fall-back-to-live path is observable (it is called, once, with a warning)
 * without paying for ts-morph. `onLoad` runs when the module is first imported, `onExtract` per extraction.
 */
export function stubbedIrLive(hooks: { onLoad?: () => void; onExtract?: () => void } = {}) {
  hooks.onLoad?.();
  return {
    POLICY_EXTRACT_NAMESPACE: 'policy',
    extractPolicyOperationsLive: async (): Promise<Operation[]> => {
      hooks.onExtract?.();
      return await shippedOperations();
    },
    bakePolicyIr: async (): Promise<never> => {
      throw new Error('bakePolicyIr is not available in the unit lane (see the e2e lane)');
    },
  };
}
