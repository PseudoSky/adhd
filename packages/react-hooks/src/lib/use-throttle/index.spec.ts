// src/hooks/useThrottle/useThrottle.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useThrottle } from '.';

describe('useThrottle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should throttle function calls', () => {
        const callback = vi.fn();
        const { result } = renderHook(() => useThrottle(callback, { delay: 1000 }));
        const throttledFn = result.current;

        act(() => {
            throttledFn();
        });
        expect(callback).toHaveBeenCalledTimes(1); // Leading edge

        act(() => {
            throttledFn();
            throttledFn();
        });
        expect(callback).toHaveBeenCalledTimes(1); // Still throttled

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(callback).toHaveBeenCalledTimes(2); // After throttle
    });

    it('should handle leading edge only', () => {
        const callback = vi.fn();
        const { result } = renderHook(() =>
            useThrottle(callback, {
                delay: 1000,
                leading: true,
                trailing: false
            })
        );
        const throttledFn = result.current;

        act(() => {
            throttledFn();
        });
        expect(callback).toHaveBeenCalledTimes(1); // Leading edge

        act(() => {
            throttledFn();
            throttledFn();
        });
        expect(callback).toHaveBeenCalledTimes(1); // Throttled

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(callback).toHaveBeenCalledTimes(1); // No trailing edge
    });

    it('should handle trailing edge only', () => {
        const callback = vi.fn();
        const { result } = renderHook(() =>
            useThrottle(callback, {
                delay: 1000,
                leading: false,
                trailing: true
            })
        );
        const throttledFn = result.current;

        act(() => {
            throttledFn();
        });
        expect(callback).toHaveBeenCalledTimes(0); // No leading edge

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(callback).toHaveBeenCalledTimes(1); // Trailing edge
    });

    it('should preserve function arguments', () => {
        const callback = vi.fn();
        const { result } = renderHook(() => useThrottle(callback, { delay: 1000 }));
        const throttledFn = result.current;

        act(() => {
            throttledFn(1, 'test');
        });
        expect(callback).toHaveBeenCalledWith(1, 'test');
    });

    it('should cleanup on unmount', () => {
        const callback = vi.fn();
        const { unmount } = renderHook(() =>
            useThrottle(callback, { delay: 1000 })
        );

        unmount();
        // Verify no memory leaks (timeout cleared)
        expect(vi.getTimerCount()).toBe(0);
    });

    it('should handle multiple instances independently', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        const { result: result1 } = renderHook(() =>
            useThrottle(callback1, { delay: 1000 })
        );
        const { result: result2 } = renderHook(() =>
            useThrottle(callback2, { delay: 1000 })
        );

        act(() => {
            result1.current();
            result2.current();
        });

        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
    });
});
