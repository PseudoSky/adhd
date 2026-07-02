import local from '..';

test('ensure', () => {
  expect(local.ensure('./src/index.js')).toBe(true);
  expect(local.ensure('./src/local.js')).toBe(false);
  expect(local.ensure('http://localhost')).toBe(false);
});

const fixtures = [
  ['./tests/fixtures/index.css', 'css'],
  ['./tests/fixtures/index.html', 'html'],
  ['./tests/fixtures/index.js', 'javascript'],
  ['./tests/fixtures/index.js?q=1', 'javascript'],
  ['./tests/fixtures/index.json', 'json'],
  ['./tests/fixtures/index.map', 'sourcemap'],
  ['./tests/fixtures/css.fromContent', 'css'],
  ['./tests/fixtures/html.fromContent', 'html'],
  ['./tests/fixtures/js.fromContent', 'javascript'],
  ['./tests/fixtures/json.fromContent', 'json'],
  ['./tests/fixtures/map.fromContent', 'sourcemap'],
  ['./tests/fixtures/sourcemap.json', 'sourcemap'],
  ['./tests/fixtures/empty.json', 'json'],
];
for (const f of fixtures) {
  let name = `name: ${f[0].split('/')[3]} -> ${f[1]} from `;
  name += f[0].endsWith('fromContent') ? `content` : `file name`;
  test(`file inference ${name}`, async () => {
    const res = await local.getFileInfo(f[0]);
    expect(res.type.toLowerCase()).toBe(f[1]);
  });
}
// t.deepEqual(local.getFileInfo('./src/index.map?q=1234'), {
// root: '',
// dir: './src',
// base: 'index.map',
// ext: '.map',
// name: 'index',
// exists: false,
// type: 'SourceMap'
// })
// t.deepEqual(local.getFileInfo('./index.js?q=1234'), {
//   root: '',
//   dir: '.',
//   base: 'index.js',
//   ext: '.js',
//   name: 'index',
//   exists: false,
//   type: 'JavaScript'
// })
// t.deepEqual(local.getFileInfo('./index.js'), {
//   root: '',
//   dir: '.',
//   base: 'index.js',
//   ext: '.js',
//   name: 'index',
//   exists: true,
//   type: 'JavaScript'
// })
// t.deepEqual(local.getFileInfo('./src/index.css'), {
//   root: '',
//   dir: './src',
//   base: 'index.css',
//   ext: '.css',
//   name: 'index',
//   exists: false,
//   type: 'CSS'
// })
// t.deepEqual(local.getFileInfo('./src/index.html'), {
//   root: '',
//   dir: './src',
//   base: 'index.html',
//   ext: '.html',
//   name: 'index',
//   exists: false,
//   type: 'HTML'
// })
// t.deepEqual(local.getFileInfo('./src/index.html?m=8'), {
//   root: '',
//   dir: './src',
//   base: 'index.html',
//   ext: '.html',
//   name: 'index',
//   exists: false,
//   type: 'HTML'
// })
// });
