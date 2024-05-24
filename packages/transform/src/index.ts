import _Functions from './lib/function';
import _Objects from './lib/object';
import _Stats from './lib/stats';
import _Collections from './lib/collections';
import _Filters from './lib/filters';
import _Texts from './lib/text';
export const Functions = _Functions;
export const Objects = _Objects;
export const Stats = _Stats;
export const Collections = _Collections;
export const Filters = _Filters;
export const Texts = _Texts;
 
export default {
  ..._Functions,
  ..._Objects,
  ..._Stats,
  ..._Collections,
  ..._Filters,
  ..._Texts,
};
