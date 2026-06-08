// src/hooks/useThrottle/useThrottle.ts
import { useCallback, useEffect, useRef } from 'react';

export interface UseThrottleOptions {
    delay?: number;
    leading?: boolean;
    trailing?: boolean;
}

export function useThrottle<T extends (...args: any[]) => any>(
    callback: T,
    options: UseThrottleOptions = {}
): T {
    const {
        delay = 300,
        leading = true,
        trailing = true
    } = options;

    const timeoutRef = useRef<NodeJS.Timeout>();
    const lastRanRef = useRef<number>(0);
    const hasRanRef = useRef(false);
    const lastArgsRef = useRef<Parameters<T>>();
    const mountedRef = useRef(true);

    // Cleanup
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

    return useCallback((...args: Parameters<T>) => {
        const now = Date.now();
        lastArgsRef.current = args;

        const execute = () => {
            lastRanRef.current = now;
            callback(...(lastArgsRef.current as Parameters<T>));
        };

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        if (!hasRanRef.current) {
            // First invocation
            hasRanRef.current = true;
            if (leading) {
                execute();
                return;
            }
            // No leading edge — schedule trailing if enabled
            lastRanRef.current = now;
            if (trailing) {
                timeoutRef.current = setTimeout(() => {
                    if (mountedRef.current) {
                        execute();
                    }
                }, delay);
            }
            return;
        }

        const remaining = delay - (now - lastRanRef.current);

        if (remaining <= 0) {
            execute();
        } else if (trailing) {
            timeoutRef.current = setTimeout(() => {
                if (mountedRef.current) {
                    execute();
                }
            }, remaining);
        }
    }, [callback, delay, leading, trailing]) as T;
}