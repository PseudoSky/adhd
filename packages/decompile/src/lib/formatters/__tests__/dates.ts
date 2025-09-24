import test from 'ava';
import formatDate from '../dates';

const dayAbbr = '\\w{3,4}';
const monthAbbr = '\\w{3,4}';
const mTitle = '\\w+';
const dTitle = '\\w+';

test('ensure', (t) => {
  t.regex(
      formatDate(new Date()),
      /\d{2}\/\d{2}\/\d{4}/,
  );

  t.regex(
      formatDate(new Date(), 'EEEE, MMMM d, yyyy hh:mm:ss:S'),
      new RegExp(
          `${dTitle}, ${mTitle} \\d{2}, \\d{4} \\d{2}:\\d{2}:\\d{2}:\\d{1,3}`,
      ),
  );

  t.regex(
      formatDate(new Date(), 'EEE, MMM d, yyyy hh:mm'),
      new RegExp(`${dayAbbr}, ${monthAbbr} \\d{2}, \\d{4} \\d{2}:\\d{1,3}`),
  );

  t.regex(
      formatDate(new Date(), 'yyyy-MM-dd hh:mm:ss:S'),
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:\d{3}/,
  );

  t.regex(
      formatDate(new Date(), 'yyMMdd-hh:mm'),
      /\d{2}\d{2}\d{2}-\d{2}:\d{2}/,
  );
});
