/**
 * contract-anchors.spec.ts — keeps `CONTRACT.md`'s `(file.ts:NNN)` line
 * references honest (DEBT 1e12507f).
 *
 * Every `###` heading in `CONTRACT.md` cites its source declaration as
 * `(\`<file>.ts:<line>\`)`. Those anchors had drifted systematically (every
 * anchor in `tx.ts`/`catalog.ts`/`errors.ts`/`audit.ts` — up to +280 — because
 * the sources grew while the prose did not). A one-time re-anchor is a
 * rewrite; this spec is what keeps it true, the same way
 * `src/vocabulary-gate.spec.ts` keeps the vocabulary rewrite true.
 *
 * The check is deliberately structural, not a diff: it asserts the cited line
 * still STARTS the named symbol's declaration. Re-anchoring is mechanical when
 * it fails — move the number to where the declaration now sits. It also
 * asserts the parser saw EVERY reference in the file, so a future anchor added
 * outside the heading shape fails loudly instead of silently escaping the
 * check.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(
  fileURLToPath(new URL('./CONTRACT.md', import.meta.url)),
  'utf8'
);

/** `### \`Sym(args)\` — kind (\`file.ts:NNN\`)` — the only shape the table uses. */
const HEADING_REF_RE = /^###\s+`([^`]+)`\s+—[^(]+\(`([a-z0-9-]+\.ts):(\d+)`\)/;
/** Any `(\`file.ts:NNN\`)` reference anywhere — used to prove none escaped the heading parse. */
const ANY_REF_RE = /\(`[a-z0-9-]+\.ts:\d+`\)/g;

/** The declaration shape the anchored line must open with. */
function declarationRe(sym: string): RegExp {
  const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^export\\s+(?:abstract\\s+)?(?:async\\s+)?(?:class|interface|type|const|function)\\s+${escaped}\\b`
  );
}

interface IAnchor {
  sym: string;
  file: string;
  line: number;
}

const anchors: IAnchor[] = contract
  .split('\n')
  .map((line) => HEADING_REF_RE.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => ({
    sym: m[1]!.replace(/\(.*$/, ''),
    file: m[2]!,
    line: Number(m[3]!),
  }));

describe('CONTRACT.md line-reference anchors are not stale (DEBT 1e12507f)', () => {
  it('every (file.ts:NNN) reference sits on the declaration line of the symbol it names', () => {
    expect(anchors.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const { sym, file, line } of anchors) {
      const lines = readFileSync(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        'utf8'
      ).split('\n');
      const cited = lines[line - 1] ?? '';
      if (!declarationRe(sym).test(cited)) {
        problems.push(
          `${file}:${line} should declare \`${sym}\` but reads: ${cited.trim().slice(0, 90)}`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('the parser accounts for EVERY reference in the file — a new non-heading anchor cannot escape', () => {
    const totalRefs = (contract.match(ANY_REF_RE) ?? []).length;
    expect(anchors.length).toBe(totalRefs);
  });
});
