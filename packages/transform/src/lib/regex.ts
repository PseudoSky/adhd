interface CacheEntry {
  min: number;
  a: number;
  max: number;
  b: number;
  isPadded?: any;
  maxLen?: number;
  negatives?: any;
  positives?: any;
  result?: string;
  string?: any;
}
const RegexRange = {
  cache: {} as Record<string, CacheEntry>,
  clearCache: () => (RegexRange.cache = {}),
};
interface Options {
  shorthand?: boolean;
  capture?: boolean;
  relaxZeros?: boolean;
}

interface Pattern {
  pattern: string;
  digits: number[];
  string?: string;
}

/**
 * Zip strings (`for in` can be used on string characters)
 */

const zip = (a: any[] | string, b: any[] | string) => {
  const arr = [];
  for (let i = 0; i < a.length; i++) {
    arr.push([a[i], b[i]]);
  }
  return arr;
};

const compare = (a: number, b: number) => {
  if (a > b) return 1;
  return b > a ? -1 : 0;
};

const push = (arr: any[], ele: any) => {
  if (arr.indexOf(ele) === -1) {
    arr.push(ele);
  }
  return arr;
};

const contains = (arr: any[], key: string, val: number | string) => {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i][key] === val) {
      return true;
    }
  }
  return false;
};

const countNines = (min: number, len: number) => {
  return String(min).slice(0, -len) + '9'.repeat(len);
};

const countZeros = (integer: number, zeros: number) => {
  return integer - (integer % Math.pow(10, zeros));
};

const toQuantifier = (digits: number[]) => {
  const start = digits[0];
  const stop = digits[1] ? `,${digits[1]}` : '';
  if (!stop && (!start || start === 1)) {
    return '';
  }
  return `{${start}${stop}}`;
};

const toCharacterClass = (a: number, b: number) => {
  return `[${a + (b - a === 1 ? '' : '-') + b}]`;
};

const padding = (str: string) => {
  return /^-?(0+)[1-9]/.exec(str);
};

const padZeros = (val: number | string, token: CacheEntry) => {
  if (token.isPadded && token.maxLen) {
    const diff = Math.abs(token.maxLen - String(val).length);
    switch (diff) {
      case 0:
        return '';
      case 1:
        return '0';
      default: {
        return `0{${diff}}`;
      }
    }
  }
  return String(val);
};

const filterPatterns = (
  arr: Pattern[],
  comparison: Pattern[],
  prefix: string,
  intersection: boolean,
  options: Options
) => {
  const res = [];

  for (let i = 0; i < arr.length; i++) {
    const token = arr[i];
    let ele = token.string;

    if (options.relaxZeros !== false) {
      if (prefix === '-' && ele && ele.charAt(0) === '0') {
        if (ele.charAt(1) === '{') {
          ele = `0*${ele.replace(/^0\{\d+\}/, '')}`;
        } else {
          ele = `0*${ele.slice(1)}`;
        }
      }
    }

    if (!intersection && ele && !contains(comparison, 'string', ele)) {
      res.push(prefix + ele);
    }

    if (intersection && ele && contains(comparison, 'string', ele)) {
      res.push(prefix + ele);
    }
  }
  return res;
};

const splitToRanges = (min: number, max: number) => {
  min = Number(min);
  max = Number(max);

  let nines = 1;
  let stops = [max];
  let stop = +countNines(min, nines);

  while (min <= stop && stop <= max) {
    stops = push(stops, stop);
    nines += 1;
    stop = +countNines(min, nines);
  }

  let zeros = 1;
  stop = countZeros(max + 1, zeros) - 1;

  while (min < stop && stop <= max) {
    stops = push(stops, stop);
    zeros += 1;
    stop = countZeros(max + 1, zeros) - 1;
  }

  stops.sort(compare);
  return stops;
};

/**
 * Convert a range to a regex pattern
 * @param {Number} `start`
 * @param {Number} `stop`
 * @return {String}
 */

const rangeToPattern = (
  start: number,
  stop: number,
  options: Options
): Pattern => {
  if (start === stop) {
    return {
      pattern: String(start),
      digits: [],
    };
  }

  const zipped = zip(String(start), String(stop));
  const len = zipped.length;
  let i = -1;

  let pattern = '';
  let digits = 0;

  while (++i < len) {
    const numbers = zipped[i];
    const startDigit = numbers[0];
    const stopDigit = numbers[1];

    if (startDigit === stopDigit) {
      pattern += startDigit;
    } else if (startDigit !== '0' || stopDigit !== '9') {
      pattern += toCharacterClass(startDigit, stopDigit);
    } else {
      digits += 1;
    }
  }

  if (digits) {
    pattern += options.shorthand ? '\\d' : '[0-9]';
  }

  return { pattern: pattern, digits: [digits] };
};

const splitToPatterns = (
  min: number,
  max: number,
  token: CacheEntry,
  options: Options
): Pattern[] => {
  const ranges = splitToRanges(min, max);
  const len = ranges.length;
  let idx = -1;

  const tokens = [];
  let start = min;
  let prev;

  while (++idx < len) {
    const range = ranges[idx];
    const obj = rangeToPattern(start, range, options);
    let zeros = '';

    if (!token.isPadded && prev && prev.pattern === obj.pattern) {
      if (prev.digits.length > 1) {
        prev.digits.pop();
      }
      prev.digits.push(obj.digits[0]);
      prev.string = prev.pattern + toQuantifier(prev.digits);
      start = range + 1;
      continue;
    }

    if (token.isPadded) {
      zeros = padZeros(range, token);
    }

    obj.string = zeros + obj.pattern + toQuantifier(obj.digits);
    tokens.push(obj);
    start = range + 1;
    prev = obj;
  }

  return tokens;
};

const siftPatterns = (neg: Pattern[], pos: Pattern[], options: Options) => {
  const onlyNegative = filterPatterns(neg, pos, '-', false, options) || [];
  const onlyPositive = filterPatterns(pos, neg, '', false, options) || [];
  const intersected = filterPatterns(neg, pos, '-?', true, options) || [];
  const subpatterns = onlyNegative.concat(intersected).concat(onlyPositive);
  return subpatterns.join('|');
};

const toRegexRange = (
  boundA?: number,
  boundB?: number,
  options?: Options
): string => {
  const min = parseInt(`${boundA}`, 10);
  const max = parseInt(`${boundB}`, 10);
  // UNBOUNDED STRICTLY NUMBER
  if (isNaN(min) && isNaN(max)) {
    return '(-?[0-9]+)';
  }
  if (isNaN(min)) {
    return toRegexRange(Number.MIN_SAFE_INTEGER, boundB, options);
  }

  if (isNaN(max)) {
    return toRegexRange(boundA, Number.MAX_SAFE_INTEGER, options);
  }

  // BOUNDS OUT OF ORDER
  if (!(isNaN(min) || isNaN(max)) && max < min) {
    return toRegexRange(boundB, boundA, options);
  }

  if (max === Number.MAX_SAFE_INTEGER && min === Number.MIN_SAFE_INTEGER) {
    return '(-?[0-9]+)';
  }
  // UNBOUNDED MAX
  if (max === Number.MAX_SAFE_INTEGER) {
    if (min === 0) {
      return '([0-9]+)';
    } else if (min < 0) {
      return `(${toRegexRange(min, 0, options)}|([0-9]+))`;
    } else {
      return `(${toRegexRange(min, min * 10, options)}[0-9]*)`;
    }
  }

  // UNBOUNDED MIN
  if (min === Number.MIN_SAFE_INTEGER) {
    if (min === 0) {
      return '(-[0-9]+)';
    } else if (max < 0) {
      return `(${toRegexRange(max * 10, max, options)}[0-9]*)`;
    } else {
      return `(${toRegexRange(0, max, options)}|(-[0-9]+))`;
    }
  }

  options = options || {};
  const relax = String(options.relaxZeros);
  const shorthand = String(options.shorthand);
  const capture = String(options.capture);
  const key = `${min}:${max}=${relax}${shorthand}${capture}`;
  if (key in RegexRange.cache) {
    return RegexRange.cache[key].result || '';
  }

  let a = Math.min(min, max);
  const b = Math.max(min, max);

  // DISTANCE OF 1 '(a|b)'
  if (Math.abs(a - b) === 1) {
    const result = `${min}|${max}`;
    if (options.capture) {
      return `(${result})`;
    }
    return result;
  }

  const isPadded = padding(String(min)) || padding(String(max));
  let positives: Pattern[] = [];
  let negatives: Pattern[] = [];

  const token: CacheEntry = { min, max, a, b };
  if (isPadded) {
    token.isPadded = isPadded;
    token.maxLen = String(token.max).length;
  }

  if (a < 0) {
    const newMin = b < 0 ? Math.abs(b) : 1;
    const newMax = Math.abs(a);
    negatives = splitToPatterns(newMin, newMax, token, options);
    a = token.a = 0;
  }

  if (b >= 0) {
    positives = splitToPatterns(a, b, token, options);
  }

  token.negatives = negatives;
  token.positives = positives;
  token.result = siftPatterns(negatives, positives, options);

  if (options.capture && positives.length + negatives.length > 1) {
    token.result = `(${token.result})`;
  }

  RegexRange.cache[key] = token;
  return token.result;
};

/* escapePattern
 * A function that replaces regular expression escape/reserved characters
 * Used primarily for sanitizing search queries
 *
 * EXAMPLE:
 * searchQuery="(([a-z]+))+(aaaaaaaaaa)+hacks"
 * escapePattern(searchQuery)
 *
 * -> "\(\(\[a\-z\]\+\)\)\+\(aaaaaaaaaa\)\+hacks"
 */
export const escapePattern = (s: string) => {
  // TODO "check this"
  // eslint-disable-next-line no-useless-escape
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
};

// const regexAny = (patterns: string[]) => {
//     return new RegExp(patterns.join('|'))
// }

/* mergePatterns
 * -------------------
 * Description: Takes an array of values and builds a regular expression that matches any of the values
 *
 * Returns: The return value is the string of the regular expression
 *
 * Example:
 *   mergePatterns([
 *     '.*sky.*',
 *     'run away',
 *     'and hide',
 *   ])
 *   -> "/.*sky.*|run away|and hide/"
 */
export const mergePatterns = (values: (string | number)[]) => {
  const joinedPatterns = values
    .map((v) => v.toString())
    .map((v) => {
      // extract the pertinent parts of the regex
      const start = v.startsWith('/') ? 1 : 0;
      const end = v.endsWith('/') ? v.length - 1 : v.length;
      return v.slice(start, end);
    })
    .join('|');
  return `/${joinedPatterns}/`;
};

/* rangeToRegex
 * -------------------
 * Description:
 * Accepts two numbers or number like strings representing an upper and lower bound of a numeric range. The function returns a regular expression that will match any number within the range for string values.
 *
 * Returns: A regular expression
 *
 * Example:
 *
 * rangeToRegex(1, 90)
 * -> /^([1-9]|[1-8][0-9]|90)$/
 *
 * rangeToRegex(null, 90)
 * -> /^(([0-9]|[1-8][0-9]|90)|(-[0-9]+))$/
 *
 * rangeToRegex(90, null)
 * /^((9[0-9]|[1-8][0-9]{2}|900)[0-9]*)$/
 *
 * rangeToRegex(-90, null)
 * /^((-[1-9]|-[1-8][0-9]|-90|0)|([0-9]+))$/
 */
export const rangeToRegex = (n1?: number, n2?: number) =>
  new RegExp(
    '^' +
    toRegexRange(n1, n2, {
      relaxZeros: false,
      capture: true,
    }) +
    '$'
  );

export default {
  escapePattern,
  mergePatterns,
  rangeToRegex,
}
