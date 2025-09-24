/* eslint-disable max-len */
const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];
const dayOfWeekNames = [
  'Sunday', 'Monday', 'Tuesday',
  'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
export const formatDate = (date?: Date, formatStr = 'yyMMdd-hhmm') => {
  if (!date) {
    date = new Date();
  }
  const day = date.getDate();
  const month = date.getMonth();
  const year = date.getFullYear();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  const miliseconds = date.getMilliseconds();
  const hh = twoDigitPad(hour);
  const mm = twoDigitPad(minute);
  const ss = twoDigitPad(second);
  const EEEE = dayOfWeekNames[date.getDay()];
  const EEE = EEEE.substr(0, 3);
  const dd = twoDigitPad(day);
  const M = month + 1;
  const MM = twoDigitPad(M);
  const MMMM = monthNames[month];
  const MMM = MMMM.substr(0, 3);
  const yyyy = year + '';
  const yy = yyyy.substr(2, 2)
    ;
  return formatStr
    .replace('hh', hh).replace('h', `${hour}`)
    .replace('mm', mm).replace('m', `${minute}`)
    .replace('ss', ss).replace('s', `${second}`)
    .replace('S', `${miliseconds}`)
    .replace('dd', dd).replace('d', `${day}`)
    .replace('MMMM', MMMM).replace('MMM', MMM).replace('MM', MM).replace('M', `${M}`)
    .replace('EEEE', EEEE).replace('EEE', EEE)
    .replace('yyyy', yyyy)
    .replace('yy', yy)
    ;
};

const twoDigitPad = (num) => {
  return num < 10 ? '0' + num : num;
};

export default formatDate;
