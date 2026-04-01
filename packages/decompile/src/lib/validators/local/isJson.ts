import parse from 'json-to-ast';

const rxOne = /^[\],:{}\s]*$/;
const rxTwo = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g;
const rxThree = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/g;
const rxFour = /(?:^|:|,)(?:\s*\[)+/g;

const isJson = (s) => {
  console.log('Parser(JSON:regex)');
  return rxOne.test(
    s
      .replace(rxTwo, '@')
      .replace(rxThree, ']')
      .replace(rxFour, ''),
  );
};

/* https://github.com/vtrushin/json-to-ast */
// eslint-disable-next-line no-unused-vars
const astJSON = (s) => {
  console.log('Parser(JSON:ast)');
  try {
    parse(s);
    return true;
  } catch (e) {
    return false;
  }
};

const Bench = {
  count: 0,
  total: 0,
};

const benchWrapper = (func) => {
  return (s) => {
    const start = new Date();
    const res = func(s);
    const end = new Date().getTime() - start.getTime();
    Bench.total += end;
    Bench.count += 1;
    console.log(res);
    console.info('Execution time: %dms', end);
    console.info('Avg time: %dms', Bench.total / Bench.count);
    return res;
  };
};

export default benchWrapper(isJson);
