// src/hooks/useCopyToClipboard/useCopyToClipboard.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCopyToClipboard } from '.';

describe('useCopyToClipboard', () => {
    const originalClipboard = { ...global.navigator.clipboard };
    const mockWriteText = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: mockWriteText },
            writable: true
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Object.defineProperty(navigator, 'clipboard', {
            value: originalClipboard,
            writable: true
        });
    });

    it('should initialize with default state', () => {
        const { result } = renderHook(() => useCopyToClipboard());

        expect(result.current.copied).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('should handle successful copy', async () => {
        mockWriteText.mockResolvedValueOnce(undefined);
        const onSuccess = vi.fn();

        const { result } = renderHook(() => useCopyToClipboard({ onSuccess }));

        await act(async () => {
            await result.current.copyToClipboard('test text');
        });

        expect(result.current.copied).toBe(true);
        expect(result.current.error).toBeNull();
        expect(onSuccess).toHaveBeenCalled();
        expect(mockWriteText).toHaveBeenCalledWith('test text');
    });

    it('should handle copy failure', async () => {
        const testError = new Error('Copy failed');
        mockWriteText.mockRejectedValueOnce(testError);
        const onError = vi.fn();

        const { result } = renderHook(() => useCopyToClipboard({ onError }));

        await act(async () => {
            await result.current.copyToClipboard('test text');
        });

        expect(result.current.copied).toBe(false);
        expect(result.current.error).toEqual(testError);
        expect(onError).toHaveBeenCalledWith(testError);
    });

    it('should reset copied state after duration', async () => {
        mockWriteText.mockResolvedValueOnce(undefined);
        const successDuration = 1000;

        const { result } = renderHook(() =>
            useCopyToClipboard({ successDuration })
        );

        await act(async () => {
            await result.current.copyToClipboard('test text');
        });

        expect(result.current.copied).toBe(true);

        act(() => {
            vi.advanceTimersByTime(successDuration);
        });

        expect(result.current.copied).toBe(false);
    });

    it('should use custom success duration', async () => {
        mockWriteText.mockResolvedValueOnce(undefined);
        const successDuration = 5000;

        const { result } = renderHook(() =>
            useCopyToClipboard({ successDuration })
        );

        await act(async () => {
            await result.current.copyToClipboard('test text');
        });

        expect(result.current.copied).toBe(true);

        act(() => {
            vi.advanceTimersByTime(2000);
        });

        expect(result.current.copied).toBe(true);

        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(result.current.copied).toBe(false);
    });

    it('should return success status from copyToClipboard', async () => {
        mockWriteText.mockResolvedValueOnce(undefined);

        const { result } = renderHook(() => useCopyToClipboard());

        let success: boolean = false;
        await act(async () => {
            success = await result.current.copyToClipboard('test text');
        });

        expect(success).toBe(true);
    });

    it('should return failure status from copyToClipboard', async () => {
        mockWriteText.mockRejectedValueOnce(new Error('Copy failed'));

        const { result } = renderHook(() => useCopyToClipboard());

        let success: boolean = false;
        await act(async () => {
            success = await result.current.copyToClipboard('test text');
        });

        expect(success).toBe(false);
    });
});
