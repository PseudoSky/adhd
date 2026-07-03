import {
    formatDate,
    fromNow,
    humanDuration,
    timeFromNow,
    timeInMS,
} from './date';

const stubDate = new Date('2000-02-01T06:00:00.000Z')
// const realDateNow = Date.now.bind(global.Date);
describe('dates', () => {
    beforeEach(() => {
        // tell vitest we use mocked time
        vi.stubEnv('TZ', 'UTC');
        vi.useFakeTimers()
        vi.setSystemTime(stubDate)
    })

    afterEach(() => {
        // restoring date after each test run
        vi.useRealTimers()
        vi.unstubAllEnvs();

    })
    it('format date', () => {
        const testDate = new Date()
        expect(formatDate(testDate, 'EEEE, MMMM d, yyyy hh:mm:ss:S')).toBe("Tuesday, February 1, 2000 01:00:00:0")
        expect(formatDate(testDate, 'EEE, MMM d, yyyy hh:mm')).toBe("Tue, Feb 1, 2000 01:00")
        expect(formatDate(testDate, 'yyyy-MM-dd hh:mm:ss:S')).toBe("2000-02-01 01:00:00:0")
        expect(formatDate(testDate, 'yyMMdd-hh:mm')).toBe("000201-01:00")
        expect(formatDate(new Date("2024-04-06T09:00:00-05:00"), 'yyyy yy, M MM MMMM MMM, dd EEEE EEE, h:m:s:S hh:mm:ss, z zz Z ZZ ZZZZ')).toBe("2024 24, 4 04 April Apr, 06 Saturday Sat, 9:0:0:0 09:00:00, GMT-5 GMT-5 -05:00 -0500 America/Lima")
    });
    it('fromNow', () => {
        vi.setSystemTime(stubDate)
        expect(fromNow(20, "day")).toMatchObject(new Date('2000-02-21T06:00:00.000Z'))
    });
    it('humanDuration', () => {
        expect(humanDuration(new Date(), fromNow(20, "day"))).toMatchObject({
            text: "3 weeks from now",
            unit: "weeks",
            future: true,
            end: fromNow(20, "day"),
            start: stubDate,
            count: 3
        })
    });
    it('timeFromNow', () => {
        expect(timeFromNow(fromNow(20, "day"))).toMatchObject({
            text: "3 weeks from now",
            unit: "weeks",
            future: true,
            end: fromNow(20, "day"),
            start: stubDate,
            count: 3
        })
    });
    it('timeInMS', () => {
        expect(timeInMS["day"]).toBe(86400000)
    });

});

