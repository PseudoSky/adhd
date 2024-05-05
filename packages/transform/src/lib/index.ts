import _Functions from './function'
import _Objects from './object'
import _Stats from './stats'
import _Collections from './collections'
import _Filters from './filters'
import _Texts from './text'
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
}
