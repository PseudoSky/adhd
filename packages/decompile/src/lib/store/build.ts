import fs from 'fs';
import _ from 'lodash';
import path from 'path';
import extractSources from '../extractors/map.js';
import Store from './index.js';
import { buildPackage } from './package.js';
import { BABELRC, BLANK_PACKAGE } from './templates.js';
import { read_map } from './utils.js';

const DEPSTORE = {};
// const addDepsFor = (filePath, dependencies) => {
//   DEPSTORE[filePath] = _.keys(dependencies);
//   return dependencies;
// };


export const buildConsumer = async (outname, mapPath) => {
  // const outputDir = path.resolve(`./${outname}`);
  const rawMap = read_map(mapPath);

  const sources = await extractSources(rawMap);
  sources.filter((s) => !!s).forEach(({ name, data }) => {
    Store.addToImports(name);
    Store.addFile(name, data);
  });
};

export const build = (project, map_dir = `./maps`, prefix = 'build/', type = 'dir') => {
  const PROJECT = project;// process.env.PROJECT || 'patreon'
  const PREFIX = prefix;
  const PACKAGE = `${PROJECT}.${Date.now()}`;
  const OUTPUT_NAME = path.resolve(`${PREFIX}${PACKAGE}`);
  const OUTPUT_PATH = `${OUTPUT_NAME}.zip`;

  const buildWithPrefix = _.partial(buildConsumer, OUTPUT_NAME);
  const INPUT_DIR = map_dir;
  const promisedMaps = fs.readdirSync(INPUT_DIR).filter((file) => {
    return file.endsWith('.map');
  }).map((f) => `${INPUT_DIR}/${f}`)
    .map(buildWithPrefix);

  promisedMaps.push(Store.addFile('package.json', JSON.stringify(BLANK_PACKAGE, null, 4)));
  promisedMaps.push(Store.addFile('.babelrc', JSON.stringify(BABELRC, null, 4)));
  Promise.all(promisedMaps)
    .then(() => Store.addFile('index.js', Store.main_file))
    .then(() => buildPackage(OUTPUT_NAME, {}))
    .then((_deps) => {
      const deps = _.uniq(_deps).map((p) => ({ [p]: '*' }));
      BLANK_PACKAGE.dependencies = Object.assign({}, ...deps);
      const packagejson = JSON.stringify(BLANK_PACKAGE, null, 4);
      return Store.addFile('package.json', packagejson);
    })
    .catch((e) => {
      console.error(e);
    });
};
