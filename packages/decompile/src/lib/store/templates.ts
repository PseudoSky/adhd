const camelize = (str) => {
  return str.replace(/\W+(.)/g, function (match, chr) {
    return chr.toUpperCase();
  });
};
export const BLANK_PACKAGE = {
  'name': '@adhd',
  'description': '',
  'version': '0.0.0',
  'homepage': 'https://github.com/pseudosky/snow',
  'author': 'snow',
  'repository': 'pseudosky/snow',
  'bugs': {
    'url': 'https://github.com/pseudosky/snow/issues',
  },
  'engines': {
    'node': '>=0.10.0',
  },
  'license': 'MIT',
  'main': 'index.js',
  'scripts': {},
  'dependencies': {
  },
  'devDependencies': {
    '@babel/cli': '^7.0.0',
    '@babel/core': '^7.4.5',
    '@babel/node': '^7.0.0',
    '@babel/plugin-proposal-class-properties': '^7.0.0',
    '@babel/plugin-proposal-decorators': '^7.0.0',
    '@babel/plugin-proposal-object-rest-spread': '^7.0.0',
    '@babel/plugin-transform-async-to-generator': '*',
    '@babel/plugin-transform-modules-commonjs': '*',
    '@babel/plugin-transform-proto-to-assign': '^7.4.4',
    '@babel/plugin-transform-runtime': '^7.0.0',
    '@babel/polyfill': '^7.0.0',
    '@babel/preset-env': '^7.4.5',
    '@babel/runtime-corejs2': '^7.0.0',
    'babel-core': '7.0.0-bridge.0',
    'babel-plugin-add-module-exports': '*',
    'eslint': '^5.16.0',
    'eslint-config-google': '^0.13.0',
  },
};


export const BABELRC = {
  // "presets": ["stage-0", "react", "es2015"],
  'presets': [
    '@babel/preset-env',
  ],
  'plugins': [
    '@babel/plugin-proposal-decorators',
    '@babel/plugin-transform-modules-commonjs',
    '@babel/plugin-transform-async-to-generator',
    [
      '@babel/plugin-proposal-class-properties', { 'loose': true },
    ],
    [
      '@babel/plugin-transform-runtime', { 'polyfill': false },
    ],
  ],
};

const importFromPath = (file) => {
  return `import ${camelize(file.split('/').slice(1).join('_'))} from "./${file}";`;
};

export const entryPointWith = (imports = []) => {
  if (!imports.length) {
    return '// Could not find an entry point for the app';
  }
  return imports.map(importFromPath).join('\n');
};

export const packageWith = (depList, overrides = {}) => {
  const dependencies = depList.reduce((res = {}, p) => {
    res[p] = '*';
    console.log({ p });
    return res;
  }, {});
  return { ...BLANK_PACKAGE, dependencies, ...overrides };
};

export const babelWith: (overrides?: Partial<typeof BABELRC>) => typeof BABELRC = (
  overrides = {}
) => {
  return {
    ...overrides,
    plugins: [...BABELRC.plugins, ...(overrides.plugins || [])],
    presets: [...BABELRC.presets, ...(overrides.presets || [])],
  };
};
