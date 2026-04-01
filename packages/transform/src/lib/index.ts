import _Collections from './collections'
import _Filters from './filters'
import _Functions from './function'
import _Objects from './object'
import _Stats from './stats'
import _Texts from './text'
import _Humanize from './humanize';
import _Date from './date';
import _Regex from './regex';
export const Functions = _Functions;
export const Objects = _Objects;
export const Stats = _Stats;
export const Collections = _Collections;
export const Filters = _Filters;
export const Texts = _Texts;
export const Humanize = _Humanize;
export const Date = _Date;
export const Regex = _Regex;





// structures

export default {
  ..._Functions,
  ..._Objects,
  ..._Stats,
  ..._Collections,
  ..._Filters,
  ..._Texts,
  ..._Humanize,
  ..._Date,
  ..._Regex,
}
