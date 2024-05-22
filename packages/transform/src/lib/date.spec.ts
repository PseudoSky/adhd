import {
    formatDate,
    fromNow,
    humanDuration,
    timeFromNow,
    timeInMS,
} from './date';

const stubDate= new Date(2000, 1, 1, 1,0,0,0)
const realDateNow = Date.now.bind(global.Date);
describe('dates', () => {
    beforeEach(() => {
        // tell vitest we use mocked time
        vi.useFakeTimers()
        vi.setSystemTime(stubDate)
      })
    
      afterEach(() => {
        // restoring date after each test run
        vi.useRealTimers()

      })
    it('format date', () => {
        expect(formatDate(new Date(), 'EEEE, MMMM d, yyyy hh:mm:ss:S')).toBe("Tuesday, February 1, 2000 01:00:00:0")
        expect(formatDate(new Date(), 'EEE, MMM d, yyyy hh:mm')).toBe("Tue, Feb 1, 2000 01:00")
        expect(formatDate(new Date(), 'yyyy-MM-dd hh:mm:ss:S')).toBe("2000-01-01 01:00:00:0")
        expect(formatDate(new Date(), 'yyMMdd-hh:mm')).toBe("000101-01:00")
    });
    it('fromNow', () => {
        vi.setSystemTime(stubDate)
        expect(fromNow(20, "day")).toMatchObject(new Date(2000, 1, 21, 1,0,0,0))
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

