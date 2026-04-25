import fromBytes from './humanize';

describe('fromBytes', () => {
    it('should convert 0 bytes to "0 Bytes"', () => {
        expect(fromBytes(0)).toBe('0 Bytes');
    });

    it('should convert bytes to KB', () => {
        expect(fromBytes(1024)).toBe('1 KiB');
    });

    it('should convert bytes to MB', () => {
        expect(fromBytes(1024 * 1024)).toBe('1 MiB');
    });

    it('should convert bytes to GB', () => {
        expect(fromBytes(1024 * 1024 * 1024)).toBe('1 GiB');
    });

    it('should respect decimal places', () => {
        expect(fromBytes(1536, 1)).toBe('1.5 KiB');
    });
});
