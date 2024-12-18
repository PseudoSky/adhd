// src/lib/use-throttle-state/index.ts
import { useEffect, useRef, useState } from 'react';

export interface UseThrottleStateOptions {
    delay?: number;
    leading?: boolean;
    trailing?: boolean;
}

export function useThrottleState<T>(
    initialValue: T,
    options: UseThrottleStateOptions = {}
) {
    const {
        delay = 300,
        leading = true,
        trailing = true
    } = options;

    const [throttledValue, setThrottledValue] = useState<T>(initialValue);
    const [value, setValue] = useState<T>(initialValue);

    const lastRan = useRef<number>(0);
    const timeout = useRef<NodeJS.Timeout>();
    const mounted = useRef(true);
    const trailingValue = useRef<T>(initialValue);

    useEffect(() => {
        return () => {
            mounted.current = false;
            if (timeout.current) {
                clearTimeout(timeout.current);
            }
        };
    }, []);

    useEffect(() => {
        const now = Date.now();
        const remaining = lastRan.current + delay - now;

        // Clear any existing timeout
        if (timeout.current) {
            clearTimeout(timeout.current);
        }

        // Store the latest value for trailing edge
        trailingValue.current = value;

        if (lastRan.current === 0 && leading) {
            // First call with leading edge
            lastRan.current = now;
            setThrottledValue(value);
        } else if (remaining <= 0) {
            // Enough time has elapsed since last execution
            lastRan.current = now;
            setThrottledValue(value);
        } else if (trailing) {
            // Schedule trailing edge execution
            timeout.current = setTimeout(() => {
                if (mounted.current) {
                    lastRan.current = Date.now();
                    setThrottledValue(trailingValue.current);
                }
            }, remaining);
        }
    }, [value, delay, leading, trailing]);

    return [throttledValue, setValue] as const;
}
