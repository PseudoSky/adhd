#!/usr/bin/env node
import path from 'path';
const rootPath = path.join(__dirname, '..');

// require('@babel/register')({extends: path.join(rootPath, '.babelrc'), ignore: [/node_modules/]});
// require('core-js/stable');
// require('regenerator-runtime/runtime');

require('./reverse');
