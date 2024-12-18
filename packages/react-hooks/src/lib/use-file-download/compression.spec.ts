// src/lib/use-file-download/compression.test.ts
import { describe, expect, it, Mock, vi } from 'vitest';
import { compressBlob, decompressBlob, isCompressedBlob, isCompressionSupported } from './compression';

describe('compression utilities', () => {
    // Mock FileReader
    const mockFileReader: {
        readAsArrayBuffer: Mock<any, any>;
        result: ArrayBuffer;
        onload: any;
        onerror: any;
        error?: Error;
    } = {
        readAsArrayBuffer: vi.fn(),
        result: new ArrayBuffer(8),
        onload: null as any,
        onerror: null as any
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // @ts-ignore
        global.FileReader = vi.fn(() => mockFileReader);
    });

    it('should compress and decompress data correctly', async () => {
        if (!isCompressionSupported()) {
            console.warn('Skipping test: compression not supported in this environment');
            return;
        }

        const originalData = 'Hello, World!'.repeat(1000);
        const originalBlob = new Blob([originalData], { type: 'text/plain' });

        // Mock successful FileReader read
        vi.spyOn(mockFileReader, 'readAsArrayBuffer').mockImplementation(() => {
            setTimeout(() => mockFileReader.onload(), 0);
        });

        const compressedBlob = await compressBlob(originalBlob);
        expect(compressedBlob.size).toBeLessThan(originalBlob.size);
        expect(isCompressedBlob(compressedBlob)).toBe(true);

        const decompressedBlob = await decompressBlob(compressedBlob);
        const decompressedText = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsText(decompressedBlob);
        });

        expect(decompressedText).toBe(originalData);
    });

    it('should handle FileReader errors gracefully', async () => {
        const originalBlob = new Blob(['test']);
        const error = new Error('FileReader error');

        // Mock FileReader error
        vi.spyOn(mockFileReader, 'readAsArrayBuffer').mockImplementation(() => {
            setTimeout(() => {
                mockFileReader.error = error;
                mockFileReader.onerror();
            }, 0);
        });

        const result = await compressBlob(originalBlob);
        expect(result).toBe(originalBlob);
    });

    it('should check compression support', () => {
        const supported = isCompressionSupported();
        expect(typeof supported).toBe('boolean');
    });
});
