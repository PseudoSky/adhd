/**
 * 3ac2372b — no stale `eslint-disable` directives.
 *
 * `entrypoint/agent-mcp/src/server.ts`'s duplicated CallTool switch carried
 * `// eslint-disable-next-line @typescript-eslint/no-explicit-any` directives
 * that suppressed nothing — the rule reports nothing at those lines, so
 * `npx nx lint agent-mcp` emitted "Unused eslint-disable directive" for each.
 * A stale directive is a defect: it hides that the rule is (no longer) firing
 * and misleads the next reader. Same class: the unused `no-console` disable in
 * `live-dag.e2e.test.ts`.
 *
 * `npx nx lint agent-mcp` is the authoritative proof that the package is
 * clean; this file is the fast regression guard so a dead directive cannot
 * silently come back. It fails if any of the removed directives is restored.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url)); // .../src/__tests__
const pkgRoot = resolve(here, '..', '..'); // entrypoint/agent-mcp

const read = (rel: string): string => readFileSync(resolve(pkgRoot, rel), 'utf8');

describe('3ac2372b — no unused eslint-disable directives', () => {
  it('server.ts carries no @typescript-eslint/no-explicit-any disable directives', () => {
    const src = read('src/server.ts');
    expect(src).not.toMatch(/eslint-disable-next-line\s+@typescript-eslint\/no-explicit-any/);
  });

  it('live-dag.e2e.test.ts carries no unused no-console disable directive', () => {
    const src = read('src/__tests__/integration/live-dag.e2e.test.ts');
    expect(src).not.toMatch(/eslint-disable-next-line\s+no-console/);
  });
});
