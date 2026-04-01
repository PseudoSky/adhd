import depcheck from 'depcheck';
import path from 'path';
// import { ICruiseOptions } from 'dependency-cruiser';
import { babelWith, entryPointWith, packageWith } from './templates.js';
// const { cruise: depcruise } = require("dependency-cruiser");
const { cruise: depcruise } = await import("dependency-cruiser");

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
} as any;
export const getDeps = async (p_paths, _options = {}, src_path = "") => {
  const options: any = {
    ...defaultOptions,
    ..._options,
  };

  const project_path = p_paths[0];
  const { ext, dir, base } = path.parse(project_path);
  const full_pkg_path = path.resolve(ext ? dir : project_path);
  const full_path = path.join(full_pkg_path, src_path);
  let pathz = ext ? [project_path] : [full_path];
  pathz = [...pathz, ...p_paths.slice(1)];
  // console.log(options)
  const deps = (await depcruise(pathz, options)).output;

  if (typeof deps !== 'object' || !deps.modules) {
    throw new Error('No modules found in dependency cruise result');
  }

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
  const importedDeps = new Set(deps.modules.flatMap((m) => (m.dependencies.map((d) => ({ ...d, fpath: path.relative(m.source, d.resolved), origin: m.source })))).map((e) => e.resolved));
  const unimported = deps.modules.filter((f) => !importedDeps.has(f.source)).map((e) => e.source);

  const depFilter = hasDepType(['npm', 'unknown']);
  // CHANGE: replace fpath with source 
  const modules = deps.modules.filter((e) => e.source.indexOf(src_path) >= 0);
  const local = modules.map((e) => ({ name: e.source, importedBy: importedBy[e.source] }));

  let filtered = deps.modules.flatMap((m) => m.dependencies);
  filtered = filtered.filter(depFilter);
  const external = Array(...(new Set(filtered.filter((e) => e.module.indexOf('./') < 0).map((e) => e.module)).values()));
  return {
    local,
    importedBy,
    external,
    unimported,
    allImports,
    importedDeps: Array.from(importedDeps),
  };
};

export const cruiseDeps = async (project_path) => {
  const {
    external,
    unimported,
  } = await getDeps([project_path], 'src');
  return {
    'package.json': packageWith(external),
    'index.js': entryPointWith(unimported),
    '.babelrc': babelWith(),
  };
};

export const buildPackage = async (project_path, options): Promise<string[]> => {
  const full_path = path.resolve(project_path);
  const result = await depcheck(full_path, defaultOptions as depcheck.Options);
  return Object.keys(result.missing);
};
