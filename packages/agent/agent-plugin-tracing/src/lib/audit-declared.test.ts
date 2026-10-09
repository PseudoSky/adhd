import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 5dff26e6 AC3 — `scripts/audit_tracing.py` declares the span paths a healthy sink must carry.
 * That list is a copy of what `CORE_MAPPINGS` can emit, so it is pinned here: adding or renaming a
 * span in `mappings.ts` without updating the script turns this red (the script would otherwise
 * stop flagging a silently-dead path, or flag a path that no longer exists).
 */
describe('audit_tracing.py declared paths track CORE_MAPPINGS (5dff26e6 AC3)', () => {
  const repoRoot = join(__dirname, '..', '..', '..', '..', '..');
  const script = readFileSync(join(repoRoot, 'scripts', 'audit_tracing.py'), 'utf8');
  const mappings = readFileSync(join(__dirname, 'mappings.ts'), 'utf8');

  it('the script lists exactly the span names mappings.ts opens', () => {
    const declaredBlock = /DECLARED_PATHS = \(([\s\S]*?)\)/.exec(script)?.[1] ?? '';
    const declared = [...declaredBlock.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1] as string).sort();
    const emitted = [...mappings.matchAll(/(?:openSpan|pointSpan|pointFor)\(\s*(?:rt,\s*)?'(agent\.[a-z_.]+)'/g)].map((m) => m[1] as string);
    // permission/hitl spans are opened through pointSpan with a literal, and the provider/budget
    // point spans through pointFor(rt, '<name>', ...); collect those too.
    const literal = [...mappings.matchAll(/pointSpan\('(agent\.[a-z_.]+)'/g)].map((m) => m[1] as string);
    const all = [...new Set([...emitted, ...literal])].sort();
    expect(declared).toEqual(all);
  });
});
