// import shortid from 'shortid';
/**
 * Trims whitespace or the specified characters from the beginning and end of a string.
 * @param {string} [str=''] - The input string to trim.
 * @param {string} [c='\\s'] - The characters to trim from the string.
 * @returns {string} The trimmed string.
 */
export function trim(str='', c = '\\s'){
  return str.replace(new RegExp(`^([${c}]*)(.*?)([${c}]*)$`), '$2')
}

/**
 * Trims whitespace or the specified characters from the beginning of a string.
 * @param {string} [str=''] - The input string to trim.
 * @param {string} [c='\\s'] - The characters to trim from the string.
 * @returns {string} The trimmed string.
 */
export function trimStart(str='', c = '\\s'){
  return str.replace(new RegExp(`^([${c}]*)(.*)$`), '$2')
}

/**
 * Trims whitespace or the specified characters from the end of a string.
 * @param {string} [str=''] - The input string to trim.
 * @param {string} [c='\\s'] - The characters to trim from the string.
 * @returns {string} The trimmed string.
 */
export function trimEnd(str='', c = '\\s'){
  return str.replace(new RegExp(`^(.*?)([${c}]*)$`), '$1')
}

/**
 * Converts the first character of a string to uppercase.
 * @param {string} [str=''] - The input string.
 * @returns {string} The string with the first character capitalized.
 */
export function upperFirst(str=''){
  return `${str.charAt(0).toUpperCase()}${str.slice(1)}`
}

/**
 * Converts the first character of a string to lowercase.
 * @param {string} [str=''] - The input string.
 * @returns {string} The string with the first character in lowercase.
 */
export function lowerFirst(str=''){
  return `${str.charAt(0).toLowerCase()}${str.slice(1)}`
}

/**
 * Capitalizes the first character of a string and converts the rest to lowercase.
 * @param {string} [str=''] - The input string.
 * @returns {string} The capitalized string.
 */
export function capitalize(str=''){
  return `${str.charAt(0).toUpperCase()}${str.slice(1).toLowerCase()}`
}

/**
 * Splits a string into an array of words.
 * @param {string} [str=''] - The input string.
 * @returns {string[]} An array of words.
 */
// REF: https://github.com/blakeembrey/change-case/blob/main/packages/change-case/src/index.ts
const SPLIT_LOWER_UPPER_RE = /([\p{Ll}\d])(\p{Lu})/gu;
const SPLIT_UPPER_UPPER_RE = /(\p{Lu})([\p{Lu}][\p{Ll}])/gu;
// Regexp involved with stripping non-word characters from the result.
const DEFAULT_STRIP_REGEXP = /[^\p{L}\d]+/giu;
// The replacement value for splits.
const SPLIT_REPLACE_VALUE = "$1\0$2";
export function words(value: string) {
  let result = value.trim();

  result = result
    .replace(SPLIT_LOWER_UPPER_RE, SPLIT_REPLACE_VALUE)
    .replace(SPLIT_UPPER_UPPER_RE, SPLIT_REPLACE_VALUE);

  result = result.replace(DEFAULT_STRIP_REGEXP, "\0");

  let start = 0;
  let end = result.length;

  // Trim the delimiter from around the output string.
  while (result.charAt(start) === "\0") start++;
  if (start === end) return [];
  while (result.charAt(end - 1) === "\0") end--;

  return result.slice(start, end).split(/\0/g);
}

/**
 * Converts a string to hyphen-case (e.g., "my-string").
 * @param {string} [str=''] - The input string.
 * @returns {string} The hyphen-case string.
 */
export function hyphenCase(str='') {
  return words(str).join('-')
}

/**
 * Converts a string to lowercase.
 * @param {string} [str=''] - The input string.
 * @returns {string} The lowercase string.
 */
export function toLower(str=''){
  return str.toLowerCase()
}

/**
 * Converts a string to uppercase.
 * @param {string} [str=''] - The input string.
 * @returns {string} The uppercase string.
 */
export function toUpper(str = '') {
  return str.toUpperCase();
}

// export function shortUUID() {
//   return shortid.generate()
// }

/**
 * Formats a number as a percentage with an optional precision.
 * @param {number} n - The number to format as a percentage.
 * @param {number} [precision=2] - The number of decimal places to include.
 * @returns {string} The formatted percentage string.
 */
export function percent(n: number, precision=2) {
  const sign = n>0 ? "+" : "";
  return `${n < 0 ? "-" : sign}${Math.abs(n).toFixed(precision)}%`;
}




export default {
  trim,
  trimStart,
  trimEnd,
  upperFirst,
  lowerFirst,
  capitalize,
  toLower,
  toUpper,
  // shortUUID,
  percent,
  words,
  hyphenCase,
};
