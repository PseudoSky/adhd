import _Collections from './lib/collections';
import _Date from './lib/date';
import _Filters from './lib/filters';
import _Functions from './lib/function';
import _Humanize from './lib/humanize';
import _Objects from './lib/object';
import _Regex from './lib/regex';
import _Stats from './lib/stats';
import _Texts from './lib/text';

export const Functions = _Functions;
export const Objects = _Objects;
export const Stats = _Stats;
export const Collections = _Collections;
export const Filters = _Filters;
export const Texts = _Texts;
export const Humanize = _Humanize;
export const Date = _Date;
export const Regex = _Regex;

export const Transform = {
  ..._Functions,
  ..._Objects,
  ..._Stats,
  ..._Collections,
  ..._Filters,
  ..._Texts,
  ..._Humanize,
  ..._Date,
  ..._Regex,
};
// export default {
//   ..._Functions,
//   ..._Objects,
//   ..._Stats,
//   ..._Collections,
//   ..._Filters,
//   ..._Texts,
// };
