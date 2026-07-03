const DAY_MS = 86400000
const HOUR_MS = DAY_MS / 24
const MINUTE_MS = HOUR_MS / 60
const WEEK_MS = DAY_MS * 7
const MONTH_MS = DAY_MS * 30
const YEAR_MS = DAY_MS * 365
const SUPPORTED_FORMAT = /(yyyy|MMMM|EEEE|ZZZZ|MMM|EEE|yy|MM|dd|hh|mm|ss|ZZ|zz|M|d|h|m|s|Z|z|S|a)/g;

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
 * Extracts comprehensive data from a JS Date object.
 * Works in Node.js (v13+) and all modern browsers.
 */
function extractDateData(date = new Date()) {
  // 0. Timezone Check
  // Safety check for the Intl API (common in older environments or thin runtimes)
  const hasIntl = typeof Intl !== 'undefined' && !!Intl.DateTimeFormat;
  const resolvedOptions = hasIntl ? Intl.DateTimeFormat().resolvedOptions() : { timeZone: "UTC" };
  // 3. Timezone & Localization
  const ianaTimezone = resolvedOptions.timeZone;

  // Get Timezone Abbreviation (e.g., EST, GMT+5)
  let tzAbbr: string;
  try {
    tzAbbr = (hasIntl
      ? new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
        .formatToParts(date)
        .find(p => p.type === 'timeZoneName')?.value
      : "") || "UTC";
  } catch (e) {
    tzAbbr = "UTC";
  }
  // Calculate UTC Offset String (e.g., +05:30 or -08:00)
  const offsetTotalMin = -date.getTimezoneOffset();
  const absOffset = Math.abs(offsetTotalMin);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offsetMins = String(absOffset % 60).padStart(2, '0');
  const formattedOffset = `${offsetTotalMin >= 0 ? '+' : '-'}${offsetHours}:${offsetMins}`;


  // 1. Basic Calendar Data
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const textWeekday = dayOfWeekNames[date.getDay()]; // 0 (Sun) - 6 (Sat)
  const textMonth = monthNames[date.getMonth()];
  // 2. Time Data
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  const millisecond = date.getMilliseconds();

  // 3. Utility Formats
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const timestamp = date.getTime();

  return {
    // Core
    year,
    month,
    day,
    hour12: hour % 12 || 12,
    hour24: hour,
    meridiem: hour >= 12 ? 'PM' : 'AM',
    minute,
    second,
    millisecond,

    // Day/Week info
    textWeekday,
    textMonth,
    isWeekend: textWeekday === "Saturday" || textWeekday === "Sunday",

    // Timezone info
    ianaTimezone,
    timezoneAbbr: tzAbbr,
    utcOffset: formattedOffset,
    offsetMinutes: offsetTotalMin,

    // Helpers
    isLeapYear,
    timestamp,
    iso: date.toISOString(),
    localeDate: date.toLocaleDateString(),
    localeTime: date.toLocaleTimeString()
  };
}

function getDateTemplateData(date: Date) {
  const {
    day, month, year, hour12, hour24, minute, second, millisecond,
    ianaTimezone, timezoneAbbr, utcOffset, textWeekday, textMonth,
  } = extractDateData(date);

  return {
    d: day,
    h: hour12,
    m: minute,
    s: second,
    S: millisecond,
    a: hour24 < 12 ? "AM" : "PM",
    hh: twoDigitPad(hour12),
    mm: twoDigitPad(minute),
    ss: twoDigitPad(second),
    EEEE: textWeekday,
    EEE: textWeekday.substring(0, 3),
    dd: twoDigitPad(day),
    M: month,
    MM: twoDigitPad(month),
    MMMM: textMonth,
    MMM: textMonth.substring(0, 3),
    yyyy: year + "",
    yy: (year + "").substring(2, 4),
    z: timezoneAbbr,       // Abbreviation: "EST" or "PET"
    zz: timezoneAbbr,       // Often same as 'z' in many libs
    Z: utcOffset,          // Offset with colon: "-05:00"
    ZZ: utcOffset.replace(':', ''), // Offset without colon: "-0500"
    ZZZZ: ianaTimezone,       // Full IANA Name: "America/Lima"
  }
}

/**
 * Formats a date according to the specified format string.
 * @param {Date} date - The date to format.
 * @param {string} [formatStr='dd/mm/yyyy'] - The format string to use.
 * @returns {string} The formatted date string.
 */
export function formatDate(date: Date, formatStr = 'dd/mm/yyyy') {
  const dateParts = getDateTemplateData(date);
  return formatStr.split(SUPPORTED_FORMAT).reduce((acc = "", fmt) => {
    acc += fmt in dateParts ? dateParts[fmt as keyof typeof dateParts] : fmt
    return acc;
  })
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