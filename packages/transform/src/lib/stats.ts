/*

randomRange();
// => a floating-point number between 0 and 1

randomRange(5);
// => a floating-point number between 0 and 5

randomRange(0, 5);
// => also a floating-point number between 0 and 5

randomRange(1.2, 5.2);
// => a floating-point number between 1.2 and 5.2

*/
export function randomRange(a = 1, b = 0) {
  const lower = Math.min(a, b);
  const upper = Math.max(a, b);
  return lower + Math.random() * (upper - lower);
}

/*
randomInt();
// => just 0 or 1

randomInt(5);
// => an integer between 0 and 5

randomInt(0, 5);
// => also an integer between 0 and 5

randomInt(1.2, 5.2);
// => an integer between 2 and 5
*/
export function randomRangeInt(a = 1, b = 0) {
  const lower = Math.ceil(Math.min(a, b));
  const upper = Math.floor(Math.max(a, b));
  return Math.floor(lower + Math.random() * (upper - lower + 1))
}
export function getMin(a: number, b: number) { return a <= b ? a : b; }
export function getMax(a: number, b: number) { return a >= b ? a : b; }
export function range(list: number[]) {
  return list.reduce((acc, value) => ({
    min: getMin(value, acc.min),
    max: getMax(value, acc.max),
  }
  ), {
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  })
}

// NOT SURE WHY THIS IS CALLED ROUND TO, SEEMS LIKE WEIRD BINNING
export function roundToIncrement(x: number, increment: number) {
  const y = +x + (increment === undefined ? 0.5 : increment / 2);
  return y - (y % (increment === undefined ? 1 : +increment));
}



// export const normalizeValue = (
//   value: number,
//   minVal: number,
//   maxVal: number
// ) => {
//   return (value - minVal) / (maxVal - minVal);
// };


/**
 * Normalizes a value from one range (current) to another (new).
 *
 * @param  { Number } val    //the current value (part of the current range).
 * @param  { Number } minVal //the min value of the current value range.
 * @param  { Number } maxVal //the max value of the current value range.
 * @param  { Number } newMin //the min value of the new value range.
 * @param  { Number } newMax //the max value of the new value range.
 *
 * @returns { Number } the normalized value.
 */

// https://stats.stackexchange.com/questions/178626/how-to-normalize-data-between-1-and-1
export const normalizeBetween = (x: number, minVal: number, maxVal: number, newMin = 0, newMax = 1) => {
  return newMin + (newMax - newMin) * ((x - minVal) / (maxVal - minVal))
  // return newMin + (val - minVal) * normalizeValue(value, minVal, maxVal);
};

// TODO: Don't extract the original range from the list, and make it accept an original/new {min, max}
export function makeListNormalizer(list: number[], newMin: number, newMax: number) {
  const { max, min } = range(list);
  // if(newMin===min && newMax==max) return (value: number) => value
  return (value: number) => normalizeBetween(value, min, max, newMin, newMax);
}

export function normalize(list: number[], bounds = { min: 0, max: 1 }) {
  if (!list || list.length === 0) return list;
  const { max, min } = range(list);
  return list.map(value => normalizeBetween(value, min, max, bounds.min, bounds.max))
}

export function histogram(iterable: any[]) {
  const result = new Map();

  for (const x of iterable) {
    result.set(x, (result.get(x) || 0) + 1);
  }

  return result;
}

export class Counter extends Map {
  normalizer: (val: any) => any;
  constructor(iterable: any[] = [], normalizer = (val: any) => val) {
    super()
    this.normalizer = normalizer;
    for (const x of iterable) {
      this.add(x)
    }
  }
  setData = (values: (string | number)[]) => {
    this.clear()
    for (const v in values) {
      this.add(v)
    }
  }

  add = (value: any) => {
    const x = this.normalizer(value)
    this.set(x, (this.get(x) || 0) + 1);
  }
}
type Range = { min?: number, max?: number }
type Bin = {
  bin: number,
  x: number,
  y: number,
}
// TODO: I dont think this actually normalizes
export class NormalizedHistogram {
  config: { bins: number; start: number; step: number; standard: boolean; };
  lookup: { [k: string | number]: number };
  normalize(_value: any): number {
    throw new Error("Method not implemented.");
  }
  counter: Counter;
  range: Range;
  constructor(data: any[], bins = 10, start = 1, step = 1, standard = false) {
    this.counter = new Counter()
    this.range = {}
    this.lookup = {}
    this.config = {
      bins,
      start,
      step,
      standard,
    }

    this.setData(data)
  }

  getBin = (_value: any) => {
    const { step } = this.config;
    if (_value in this.lookup) return this.lookup[_value];
    const value = this.normalize(_value);
    const bin = roundToIncrement(value, step);
    this.lookup[_value] = bin;
    console.warn(`BIN: val=${_value} normal=${value} bin=${bin}`)
    return bin
  };
  // TODO: the bounds adjustment doesn't work
  bins = (newMin?: number, newMax?: number) => {
    // const res = [];
    const { bins, start, step } = this.config;
    const res: number[] = new Array(bins).fill(0)
    // for(let i = 0; i < bins; i += step){
    //   res[i] = 0
    // }
    for (const [k, val] of this.counter) {
      if (!this.range?.min || val < this.range.min) this.range.min = val;
      if (!this.range?.max || val > this.range.max) this.range.max = val;
      if (val) {
        res[this.getBin(k)] = res[this.getBin(k)] + val;
      }
    }
    console.warn({ lookup: this.lookup })
    // UPDATED: changed from bool
    // normalize(res, {min: newMin, max: newMax})
    return Object.entries(res).map(([x, y]) => ({ x, y })).sort(({ x }, { x: x2 }) => (x < x2) ? 1 : 0)
    // return this.counter.reduce((res,[k,v])=>{
    // }, [])

    // for (let bin = start; bin <= bins * step; bin += step) {
    //   const val = this.counter.get(bin);
    //   if(val < this.range.min) this.range.min=val
    //   if (val > this.range.max) this.range.max = val;
    //   if(val){

    //     res.push({ x: bin, y: val || 0 });
    //   }
    // }
    // return res;
  };

  setData = (data: any[]) => {
    this.range = {
      min: Number.MAX_SAFE_INTEGER,
      max: Number.MIN_SAFE_INTEGER
    };
    // let data = _data;
    // this.baseRange = range(data);
    // if(this.config.standard){
    //   data = data.map(v =>
    //     normalizeBetween(v, this.baseRange.min, this.baseRange.max, start, bins * step)
    //   );
    //   console.log({range:this.baseRange,newData:data})
    // }
    this.lookup = {};
    const { bins, start, step } = this.config
    this.normalize = makeListNormalizer(data, start, bins * step);
    this.counter = new Counter(data, (v) => this.normalize(v));
    this.bins();
  }
}

export function mostCommon(iterable: any[]) {
  let maxCount = 0;
  let maxKey;

  for (const [key, count] of histogram(iterable)) {
    if (count > maxCount) {
      maxCount = count;
      maxKey = key;
    }
  }

  return maxKey;
}

export default {
  getMin,
  getMax,
  randomRange,
  randomRangeInt,
  // normalizeValue,
  roundToIncrement,
  range,
  normalize,
  normalizeBetween,
  makeListNormalizer,
  histogram,
  mostCommon,
  Counter,
  NormalizedHistogram,
};
