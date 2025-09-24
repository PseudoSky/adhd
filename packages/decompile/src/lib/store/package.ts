import depcheck from 'depcheck';
import path from 'path';
import { babelWith, entryPointWith, packageWith } from './templates';
const util = require('util');
const depcruise = require('dependency-cruiser').cruise;
// TODO: down or upgrade depcheck;
const hasDepType = (t = []) => {
  const types = new Set(t);
  return ({ dependencyTypes }) => dependencyTypes.length && (new Set(dependencyTypes)).has(t[0]);
};
const defaultOptions = {
  sourceDir: '',
  // "ignoreMatches"
  // includeDir: false,
  doNotFollow: {
    dependencyTypes: [
      'npm',
      'npm-dev',
      'npm-optional',
      'npm-peer',
      'npm-bundled',
      'npm-no-pkg',
    ],
  },
  extends: 'dependency-cruiser/configs/recommended',
};
export const getDeps = (p_paths, _options = {}) => {
  const options = {
    ...defaultOptions,
    ..._options,
  };

  const project_path = p_paths[0];
  const { ext, dir, base } = path.parse(project_path);
  const full_pkg_path = path.resolve(ext ? dir : project_path);
  const full_path = path.join(full_pkg_path, options.sourceDir);
  let pathz = ext ? [project_path] : [full_path];
  pathz = [...pathz, ...p_paths.slice(1)];
  // console.log(options)
  const deps = depcruise(pathz, options).output;

  let importedBy = deps.modules.flatMap((m) => (m.dependencies.map((d) => ({ name: d.module.startsWith('./') ? d.resolved : d.module, origin: m.source })))).reduce((r = {}, d) => {
    r[d.name] = r[d.name] || [];
    r[d.name].push(d.origin);
    return r;
  }, {});
  deps.modules = deps.modules.map((e) => ({ ...e, fpath: path.relative(full_pkg_path, path.join(importedBy[e.source] ? path.dirname(importedBy[e.source][0]) : full_pkg_path, e.source)) })).map((o) => (path.dirname(o.source) == '.' ? { ...o, source: o.fpath } : o));
  importedBy = deps.modules.flatMap((m) => (m.dependencies.map((d) => ({ name: d.module.startsWith('./') ? d.resolved : d.module, origin: m.source })))).reduce((r = {}, d) => {
    r[d.name] = r[d.name] || [];
    r[d.name].push(d.origin);
    return r;
  }, {});
  const allImports = deps.modules.map((e) => e.source);
  let importedDeps = new Set(deps.modules.flatMap((m) => (m.dependencies.map((d) => ({ ...d, fpath: path.relative(m.source, d.resolved), origin: m.source })))).map((e) => e.resolved));
  const unimported = deps.modules.filter((f) => !importedDeps.has(f.source)).map((e) => e.source);

  const depFilter = hasDepType(['npm', 'unknown']);

  let local = deps.modules.filter((e) => e.fpath.indexOf(options.sourceDir) >= 0);
  local = local.map((e) => ({ name: e.source, importedBy: importedBy[e.source] }));

  let external = deps.modules.flatMap((m) => m.dependencies);
  external = external.filter(depFilter);
  external = external.filter((e) => e.module.indexOf('./') < 0).map((e) => e.module);
  external = new Set(external);
  external = Array(...external.values());
  importedDeps = Array(...importedDeps.values());
  return {
    local,
    importedBy,
    external,
    unimported,
    allImports,
    importedDeps,
  };
};

export const cruiseDeps = (project_path) => {
  const {
    external,
    unimported,
  } = getDeps([project_path], 'src');
  return {
    'package.json': packageWith(external),
    'index.js': entryPointWith(unimported),
    '.babelrc': babelWith(),
  };
};

export const buildPackage = (project_path, options) => {
  const full_path = path.resolve(project_path);
  return depcheck(full_path, defaultOptions, ({ missing }) => {
    return Object.keys(missing);
  });
};
