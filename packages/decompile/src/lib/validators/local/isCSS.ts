import postcss from 'postcss';

const RE =
  /([#.@*]?[\w-.:> ,*]+)[\s]?{[\r\n\s]*([A-Za-z\- \s\r\n\t]+[:][\s]*[0-9\w .,()\-!%/]+;?[\r\n]*(?:[A-Za-z\- \r\n\t]+[:][\s]*['":0-9\w .,()\-!%/]+;?[\r\n]*)*)?}/g;

const removeCSS = (s) =>
  s.replace(
    /((?:^\s*)([\w#.@*,:\-.:>,*\s]+)\s*{(?:[\s]*)((?:[A-Za-z\- \s]+[:]\s*['"0-9\w .,()\-!%/]+;?)*)*\s*}(?:\s*))/gm,
    ''
  );

const isCSS = (s) => removeCSS(s).replace(/[[\s;]+/gim, '') === '';

const astCSS = (s) => {
  console.log('Parser(CSS)');
  try {
    return !!postcss.parse(s);
  } catch (e) {
    return false;
  }
};

export default astCSS;
