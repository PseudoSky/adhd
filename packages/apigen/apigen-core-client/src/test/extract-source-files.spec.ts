/**
 * guards: extraction does not report the files it read, so a cache layer has to re-derive the dependency set itself, and an installed (node_modules) entry's own sibling files are dropped from it
 * tier: S
 * cites: backlog 39c4e00c - AC1 extract() reports the local files it read (entry included, sorted) for an installed and an ordinary tree, without changing how the result reads as Operation[]
 *
 * Consumer path: the real `extract()` over real temp source trees, read back through the public `sourceFilesOf`.
 *
 * red run (against the pre-change sources, 2026-10-14): all 3 cases failed - `sourceFilesOf` did not exist, and
 * `collectLocalImportPaths` on an installed entry returned only the entry itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectLocalImportPaths, extract, sourceFilesOf } from '../index';

let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-srcfiles-')));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function tree(base: string): { entry: string; types: string; deep: string; vendored: string } {
  const entry = path.join(base, 'api.d.ts');
  const types = path.join(base, 'write', 'types.d.ts');
  const deep = path.join(base, 'write', 'deep.d.ts');
  const vendored = path.join(base, 'node_modules', 'other', 'index.d.ts');
  for (const [f, c] of [
    [deep, 'export interface IDeep { d: number }\n'],
    [types, "import { IDeep } from './deep.js';\nexport interface IIn { a: string; deep: IDeep }\n"],
    [vendored, 'export interface IOther { o: string }\n'],
    [
      entry,
      "import { IIn } from './write/types.js';\nimport { IOther } from 'other';\nexport declare function run(i: IIn): Promise<string>;\nexport declare function other(i: IOther): Promise<string>;\n",
    ],
  ] as const) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  }
  return { entry, types, deep, vendored };
}

describe('extract() reports the files it read (39c4e00c)', () => {
  it.each([
    ['an ordinary tree', ['src']],
    ['an installed package', ['node_modules', '@scope', 'pkg']],
  ])('[AC1] %s: entry plus transitive local imports, sorted; another package stays out', async (_n, parts) => {
    const base = path.join(root, parts.join('-'), ...parts);
    const t = tree(base);
    const ops = await extract({ sourceFile: t.entry, namespace: 'x' });
    expect(sourceFilesOf(ops)).toEqual([t.entry, t.deep, t.types].sort());
    expect(collectLocalImportPaths(t.entry)).toEqual([t.entry, t.deep, t.types].sort());
  });

  it('[AC1] the list does not change how the result reads as Operation[]', async () => {
    const t = tree(path.join(root, 'plain'));
    const ops = await extract({ sourceFile: t.entry, namespace: 'x' });
    expect(sourceFilesOf(ops)).toBeDefined();
    expect(Object.keys(ops)).toEqual(ops.map((_, i) => String(i)));
    expect(JSON.parse(JSON.stringify(ops))).toEqual([...ops]);
    expect(sourceFilesOf([...ops])).toBeUndefined();
  });
});
