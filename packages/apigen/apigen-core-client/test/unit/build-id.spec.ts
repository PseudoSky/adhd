/**
 * guards: the exported buildId renders a different operation id than the extractor assigns (a second divergent copy, or a changed separator), so hosts that mint ids from namespace + path no longer match extracted operations
 * tier: S
 * cites: REMEDIATION-PLAN T-R1 DoD (buildId exported from @adhd/apigen-core-client returns the id the extractor assigns; the live extractor comparison needs ts-morph and stays in the e2e lane, so it is pinned here by the extract.e2e goldens); R1 (one exported buildId, imported by extract-classes)
 * tags: contract
 * teeth: red: change the `/` separator in buildId's `.join('/')` (guarded temporary edit, restored) and run `npx vitest run src/test/build-id.spec.ts` in packages/apigen/apigen-core-client -> exit 1; the three literal-id cases go red
 */
import { describe, expect, it } from 'vitest';
import { buildId, tokenize, type Segment } from '../../src/index';

const seg = (raw: string): Segment => ({ raw, words: tokenize(raw) });

describe('buildId (T-R1)', () => {
  it('joins namespace and path segments with "/" and words with "-"', () => {
    expect(buildId(seg('transform'), [seg('humanize'), seg('humanizeBytes')])).toBe(
      'transform/humanize/humanize-bytes'
    );
  });

  it('omits an empty namespace', () => {
    expect(buildId({ raw: '', words: [] }, [seg('getUser')])).toBe('get-user');
  });

  it('renders the ids pinned by the extractor goldens (extract.e2e.ts "get-user" / "backlog/get-user")', () => {
    // The live extractor comparison needs ts-morph (>1 s cold), so it stays in the e2e lane; these literals are
    // the ids that suite pins for the same namespace + path, so a divergent copy of buildId fails here too.
    expect(buildId({ raw: '', words: [] }, [seg('getUser')])).toBe('get-user');
    expect(buildId(seg('backlog'), [seg('getUser')])).toBe('backlog/get-user');
  });
});
