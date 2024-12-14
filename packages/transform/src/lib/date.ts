const DAY_MS = 86400000
const HOUR_MS = DAY_MS / 24
const MINUTE_MS = HOUR_MS / 60
const WEEK_MS = DAY_MS * 7
const MONTH_MS = DAY_MS * 30
const YEAR_MS = DAY_MS * 365

type DurationUnit = "hour" | "day" | "minute" | "week" | "month" | "year"
type DurationUnitPlural = "hours" | "days" | "minutes" | "weeks" | "months" | "years"
export const timeInMS: Record<DurationUnit | DurationUnitPlural, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
  minute: MINUTE_MS,
  week: WEEK_MS,
  month: MONTH_MS,
  year: YEAR_MS,
  hours: HOUR_MS,
  days: DAY_MS,
  minutes: MINUTE_MS,
  weeks: WEEK_MS,
  months: MONTH_MS,
  years: YEAR_MS
}

type HumanDuration = {
  start: Date;
  end: Date;
  delta: number;
  unit: DurationUnit | DurationUnitPlural;
  count: number;
  future: boolean;
  text: string;
}

/**
 * Calculates the human-readable duration between two dates.
 * @param {Date} [d0=new Date()] - The start date.
 * @param {Date} [d1=new Date()] - The end date.
 * @param {DurationUnit} [unit] - The optional unit of duration to use.
 * @returns {Partial<HumanDuration>} An object containing the duration details.
 */
export function humanDuration(d0 = (new Date()), d1 = (new Date()), unit?: DurationUnit) {
  const res: Partial<HumanDuration> = {};
  res.start = new Date(d0)
  res.end = new Date(d1)
  res.delta = (+res.end) - (+res.start);
  const absDelta = Math.abs(res.delta)
  if (!unit) {
    if (absDelta - DAY_MS < 0) {
      res.unit = 'hour'
    } else if (absDelta - WEEK_MS < 0) {
      res.unit = 'day'
    } else if (absDelta - MONTH_MS < 0) {
      res.unit = 'week'
    } else if (absDelta - YEAR_MS < 0) {
      res.unit = 'month'
    } else {
      res.unit = 'year'
    }
  } else {
    res.unit = unit
  }

  res.count = Math.round(absDelta / timeInMS[res.unit])
  res.future = res.delta > 0
  if (res.count != 1) res.unit += 's'
  res.text = `${res.count} ${res.unit} ${res.future ? 'from now' : 'ago'}`
  return res
}

/**
 * Calculates the time from the current date to a given date.
 * @param {Date} date - The date to calculate the time from.
 * @returns {Partial<HumanDuration>} An object containing the duration details.
 */
export function timeFromNow(date: Date) {
  return humanDuration((new Date()), date)
}

/**
 * Calculates a date in the future from the current date.
 * @param {number} count - The number of units to add.
 * @param {DurationUnit} [unit='day'] - The unit of duration to use.
 * @returns {Date} The calculated future date.
 */
export function fromNow(count: number, unit: DurationUnit = 'day') {
  // console.log(new Date(Date.now()+timeInMS[unit.toLowerCase().replace(/s$/, '')]*count))
  return (new Date(Date.now() + timeInMS[unit] * count))
}

const monthNames = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"
];

const dayOfWeekNames = [
  "Sunday", "Monday", "Tuesday",
  "Wednesday", "Thursday", "Friday", "Saturday"
];

/**
 * Formats a date according to the specified format string.
 * @param {Date} date - The date to format.
 * @param {string} [formatStr='dd/mm/yyyy'] - The format string to use.
 * @returns {string} The formatted date string.
 */
export function formatDate(date: Date, formatStr = 'dd/mm/yyyy') {
  const day = date.getDate(),
    month = date.getMonth(),
    year = date.getFullYear(),
    hour = date.getHours(),
    minute = date.getMinutes(),
    second = date.getSeconds(),
    miliseconds = date.getMilliseconds(),
    hh = twoDigitPad(hour),
    mm = twoDigitPad(minute),
    ss = twoDigitPad(second),
    EEEE = dayOfWeekNames[date.getDay()],
    EEE = EEEE.substring(0, 3),
    dd = twoDigitPad(day),
    M = month,
    MM = twoDigitPad(M),
    MMMM = monthNames[month],
    MMM = MMMM.substring(0, 3),
    yyyy = year + "",
    yy = yyyy.substring(2, 4)
    ;
  return formatStr
    .replace('hh', `${hh}`).replace('h', `${hour}`)
    .replace('mm', `${mm}`).replace('m', `${minute}`)
    .replace('ss', `${ss}`).replace('s', `${second}`)
    .replace('S', `${miliseconds}`)
    .replace('dd', `${dd}`).replace('d', `${day}`)
    .replace('MMMM', MMMM).replace('MMM', MMM).replace('MM', `${MM}`).replace('M', `${M}`)
    .replace('EEEE', EEEE).replace('EEE', EEE)
    .replace('yyyy', yyyy)
    .replace('yy', yy)
    ;
}

function twoDigitPad(num: number) {
  return num < 10 ? "0" + num : num;
}

export default {
  formatDate,
  fromNow,
  humanDuration,
  timeFromNow,
  timeInMS,
}
// console.log(formatDate(new Date()));
// console.log(formatDate(new Date(), 'EEEE, MMMM d, yyyy hh:mm:ss:S'));
// console.log(formatDate(new Date(), 'EEE, MMM d, yyyy hh:mm'));
// console.log(formatDate(new Date(), 'yyyy-MM-dd hh:mm:ss:S'));
// console.log(formatDate(new Date(), 'yyMMdd-hh:mm'));