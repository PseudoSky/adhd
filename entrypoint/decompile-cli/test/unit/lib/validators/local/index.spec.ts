import path from 'path';
import local from '../../../../../src/lib/validators/local';

// Nx always runs `test` from the workspace root (verified empirically —
// process.cwd() during `nx test decompile-cli` is the repo root, not this
// package's directory), so these fixture/self paths must be resolved via
// `__dirname` rather than assumed relative to an implicit cwd.
const srcDir = path.join(__dirname, '..', '..', '..', '..', '..', 'src');
const fixturesDir = path.join(srcDir, 'tests', 'fixtures');

test('ensure', () => {
  // Pre-TS-migration this asserted against `./src/index.js`/`./src/local.js`;
  // the package is TypeScript now, so the real (existing) source file is
  // `src/index.ts` and the false-case sibling genuinely does not exist.
  expect(local.ensure(path.join(srcDir, 'index.ts'))).toBe(true);
  expect(local.ensure(path.join(srcDir, 'local.ts'))).toBe(false);
  expect(local.ensure('http://localhost')).toBe(false);
});

const fixtures: Array<[string, string]> = [
  ['index.css', 'css'],
  ['index.html', 'html'],
  ['index.js', 'javascript'],
  ['index.js?q=1', 'javascript'],
  ['index.json', 'json'],
  ['index.map', 'sourcemap'],
  ['css.fromContent', 'css'],
  ['html.fromContent', 'html'],
  ['js.fromContent', 'javascript'],
  ['json.fromContent', 'json'],
  ['map.fromContent', 'sourcemap'],
  ['sourcemap.json', 'sourcemap'],
  ['empty.json', 'json'],
];
for (const f of fixtures) {
  let name = `name: ${f[0]} -> ${f[1]} from `;
  name += f[0].endsWith('fromContent') ? `content` : `file name`;
  test(`file inference ${name}`, async () => {
    const res = await local.getFileInfo(path.join(fixturesDir, f[0]));
    expect(res.type.toLowerCase()).toBe(f[1]);
  });
}
