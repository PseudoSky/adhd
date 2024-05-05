import shortid from 'shortid';
import { noCase } from "no-case";

export function trim(str='', c = '\\s'){
  return str.replace(new RegExp(`^([${c}]*)(.*?)([${c}]*)$`), '$2')
}

export function trimStart(str='', c = '\\s'){
  return str.replace(new RegExp(`^([${c}]*)(.*)$`), '$2')
}

export function trimEnd(str='', c = '\\s'){
  return str.replace(new RegExp(`^(.*?)([${c}]*)$`), '$1')
}

export function upperFirst(str=''){
  return `${str.charAt(0).toUpperCase()}${str.slice(1)}`
}

export function lowerFirst(str=''){
  return `${str.charAt(0).toLowerCase()}${str.slice(1)}`
}

export function capitalize(str=''){
  return `${str.charAt(0).toUpperCase()}${str.slice(1).toLowerCase()}`
}

export function words(str='') {
  return noCase(str).split(' ');
}

export function hyphenCase(str='') {
  return words(str).join('-')
}

export function toLower(str=''){
  return str.toLowerCase()
}

export function toUpper(str = '') {
  return str.toUpperCase();
}

export function shortUUID() {
  return shortid.generate()
}

export function percent(n: number, precision=2) {
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(precision)}%`;
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
  shortUUID,
  percent,
  words,
  hyphenCase,
};
