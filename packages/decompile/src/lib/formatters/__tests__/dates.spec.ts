// import test from 'ava';
import formatDate from '../dates';

const dayAbbr = '\\w{3,4}';
const monthAbbr = '\\w{3,4}';
const mTitle = '\\w+';
const dTitle = '\\w+';

test('ensure', (t) => {
    expect(
        formatDate(new Date()),
    ).toMatch(
        /\d{2}\/\d{2}\/\d{4}/,
    );

    expect(
        formatDate(new Date(), 'EEEE, MMMM d, yyyy hh:mm:ss:S')
    ).toMatch(
        new RegExp(
            `${dTitle}, ${mTitle} \\d{2}, \\d{4} \\d{2}:\\d{2}:\\d{2}:\\d{1,3}`,
        )
    );

    expect(
        formatDate(new Date(), 'EEE, MMM d, yyyy hh:mm')
    ).toMatch(
        new RegExp(`${dayAbbr}, ${monthAbbr} \\d{2}, \\d{4} \\d{2}:\\d{1,3}`)
    );

    expect(
        formatDate(new Date(), 'yyyy-MM-dd hh:mm:ss:S')
    ).toMatch(
        /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:\d{3}/
    );

    expect(
        formatDate(new Date(), 'yyMMdd-hh:mm')
    ).toMatch(
        /\d{2}\d{2}\d{2}-\d{2}:\d{2}/
    );
});
