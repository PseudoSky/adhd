// src/hooks/useAsync/useAsync.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAsync } from './';

describe('useAsync', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should initialize with idle state', () => {
        const mockFn = vi.fn();
        const { result } = renderHook(() => useAsync(mockFn));

        expect(result.current.status).toBe('idle');
        expect(result.current.data).toBeNull();
        expect(result.current.error).toBeNull();
        expect(result.current.isLoading).toBe(false);
    });

    it('should handle successful async operation', async () => {
        const mockData = { id: 1, name: 'Test' };
        const mockFn = vi.fn().mockResolvedValue(mockData);
        const onSuccess = vi.fn();

        const { result } = renderHook(() => useAsync(mockFn, { onSuccess }));

        expect(result.current.status).toBe('idle');

        await act(async () => {
            await result.current.execute();
        });

        expect(result.current.status).toBe('success');
        expect(result.current.data).toEqual(mockData);
        expect(result.current.error).toBeNull();
        expect(onSuccess).toHaveBeenCalledWith(mockData);
    });

    it('should handle failed async operation', async () => {
        const mockError = new Error('Test error');
        const mockFn = vi.fn().mockRejectedValue(mockError);
        const onError = vi.fn();

        const { result } = renderHook(() => useAsync(mockFn, { onError }));

        await act(async () => {
            try {
                await result.current.execute();
            } catch (error) {
                // Expected error
            }
        });

        expect(result.current.status).toBe('error');
        expect(result.current.data).toBeNull();
        expect(result.current.error).toEqual(mockError);
        expect(onError).toHaveBeenCalledWith(mockError);
    });

    it('should execute immediately when immediate option is true', async () => {
        const mockFn = vi.fn().mockResolvedValue('test');

        renderHook(() => useAsync(mockFn, { immediate: true }));

        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should handle loading state correctly', async () => {
        const mockFn = vi.fn().mockImplementation(() =>
            new Promise(resolve => setTimeout(() => resolve('test'), 1000))
        );

        const { result } = renderHook(() => useAsync(mockFn));

        act(() => {
            result.current.execute();
        });

        expect(result.current.status).toBe('pending');
        expect(result.current.isLoading).toBe(true);

        await act(async () => {
            await vi.runAllTimers();
        });

        expect(result.current.status).toBe('success');
        expect(result.current.isLoading).toBe(false);
    });

    it('should not execute immediately when immediate option is false', () => {
        const mockFn = vi.fn().mockResolvedValue('test');

        renderHook(() => useAsync(mockFn, { immediate: false }));

        expect(mockFn).not.toHaveBeenCalled();
    });

    it('should maintain the latest state when component rerenders', async () => {
        const mockFn = vi.fn().mockResolvedValue('test');
        const { result, rerender } = renderHook(() => useAsync(mockFn));

        await act(async () => {
            await result.current.execute();
        });

        rerender();

        expect(result.current.status).toBe('success');
        expect(result.current.data).toBe('test');
    });
});
