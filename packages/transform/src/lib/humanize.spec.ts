import fromBytes from './humanize';

describe('humanizeBytes', () => {
    it('should return "0 Bytes" for 0', () => {
        expect(fromBytes(0)).toBe('0 Bytes');
    });

    it('should return bytes for values less than 1 KiB', () => {
        expect(fromBytes(1)).toBe('1 Bytes');
        expect(fromBytes(512)).toBe('512 Bytes');
        expect(fromBytes(1023)).toBe('1023 Bytes');
    });

    it('should convert to KiB', () => {
        expect(fromBytes(1024)).toBe('1 KiB');
        expect(fromBytes(1536)).toBe('1.5 KiB');
        expect(fromBytes(2048)).toBe('2 KiB');
    });

    it('should convert to MiB', () => {
        expect(fromBytes(1024 * 1024)).toBe('1 MiB');
        expect(fromBytes(1024 * 1024 * 1.5)).toBe('1.5 MiB');
        expect(fromBytes(1024 * 1024 * 10)).toBe('10 MiB');
    });

    it('should convert to GiB', () => {
        expect(fromBytes(1024 * 1024 * 1024)).toBe('1 GiB');
        expect(fromBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GiB');
    });

    it('should convert to TiB', () => {
        expect(fromBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TiB');
    });

    it('should respect decimal precision', () => {
        expect(fromBytes(1536, 0)).toBe('2 KiB');
        expect(fromBytes(1536, 1)).toBe('1.5 KiB');
        expect(fromBytes(1536, 3)).toBe('1.5 KiB');
    });

    it('should handle negative decimals by rounding to 0', () => {
        expect(fromBytes(1536, -1)).toBe('2 KiB');
    });

    it('should handle large numbers', () => {
        const largeNumber = 1024 * 1024 * 1024 * 1024 * 1024; // 1 PiB
        expect(fromBytes(largeNumber)).toBe('1 PiB');
    });
})
