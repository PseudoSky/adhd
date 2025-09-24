import * as acorn from 'acorn';
import jsx from 'acorn-jsx';

const Parser = acorn.Parser.extend(jsx());
const acornOptions = {
  'sourceType': 'module',
  'ecmaVersion': 10,
  'allowReserved': true,
  'allowReturnOutsideFunction': true,
  'allowImportExportEverywhere': true,
  'allowHashBang': true,
  'locations': true,
  'ranges': true,
  'preserveParens': true,
  'plugins.jsx': true,
};

const funcRE = /(public|private|protected)\s+(static\s+)?(abstract(?!override)\s+|final\s+)?(\D\w+)\s+(\D\w+)\s*\((\s*\D\w+\s*\D\w+\s*,?)*\)\s*/gm;

const astJS = (s) => {
  console.log('Parser(JS AST)');
  try {
    const r = Parser.parse(s, acornOptions);
    return true;
  } catch (e) {
    return false;
  }
};

export default astJS;
