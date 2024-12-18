// src/lib/use-throttle-state/use-throttle-state.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useThrottleState } from './';

describe('useThrottleState', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should initialize with initial value', () => {
        const { result } = renderHook(() => useThrottleState('initial'));
        expect(result.current[0]).toBe('initial');
    });

    it('should handle leading edge throttle', () => {
        const { result } = renderHook(() =>
            useThrottleState('initial', {
                delay: 1000,
                leading: true,
                trailing: false
            })
        );

        // First update (leading edge)
        act(() => {
            result.current[1]('update 1');
        });
        expect(result.current[0]).toBe('update 1');

        // Subsequent rapid updates should be throttled
        act(() => {
            result.current[1]('update 2');
            result.current[1]('update 3');
        });
        expect(result.current[0]).toBe('update 1');

        // After delay, next update should go through
        act(() => {
            vi.advanceTimersByTime(1000);
            result.current[1]('update 4');
        });
        expect(result.current[0]).toBe('update 4');
    });

    it('should handle trailing edge throttle', () => {
        const { result } = renderHook(() =>
            useThrottleState('initial', {
                delay: 1000,
                leading: false,
                trailing: true
            })
        );

        // First update should not go through immediately
        act(() => {
            result.current[1]('update 1');
        });
        expect(result.current[0]).toBe('initial');

        // Multiple updates within delay should be throttled
        act(() => {
            result.current[1]('update 2');
            result.current[1]('update 3');
        });
        expect(result.current[0]).toBe('initial');

        // After delay, last value should be used
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(result.current[0]).toBe('update 3');
    });

    it('should handle both leading and trailing edge throttle', () => {
        const { result } = renderHook(() =>
            useThrottleState('initial', {
                delay: 1000,
                leading: true,
                trailing: true
            })
        );

        // First update should go through (leading)
        act(() => {
            result.current[1]('update 1');
        });
        expect(result.current[0]).toBe('update 1');

        // Multiple updates within delay should be throttled
        act(() => {
            result.current[1]('update 2');
            result.current[1]('update 3');
        });
        expect(result.current[0]).toBe('update 1');

        // After delay, last value should be used (trailing)
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(result.current[0]).toBe('update 3');
    });

    it('should cleanup on unmount', () => {
        const { unmount } = renderHook(() =>
            useThrottleState('initial', { delay: 1000 })
        );

        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('should handle rapid updates correctly', () => {
        const { result } = renderHook(() =>
            useThrottleState('initial', { delay: 1000 })
        );

        // Simulate rapid updates
        act(() => {
            result.current[1]('update 1'); // Leading edge
            result.current[1]('update 2');
            result.current[1]('update 3');
            vi.advanceTimersByTime(500);
            result.current[1]('update 4');
            result.current[1]('update 5');
        });

        expect(result.current[0]).toBe('update 1'); // Leading edge value

        // After delay, should get last value
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(result.current[0]).toBe('update 5'); // Trailing edge value
    });
});
