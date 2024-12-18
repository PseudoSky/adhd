import { useCallback, useEffect, useState } from 'react';

export interface UseLocalStorageOptions<T> {
    serializer?: (value: T) => string;
    deserializer?: (value: string) => T;
    onError?: (error: Error) => void;
}

export function useLocalStorage<T>(
    key: string,
    initialValue: T,
    options: UseLocalStorageOptions<T> = {}
) {
    const {
        serializer = JSON.stringify,
        deserializer = JSON.parse,
        onError
    } = options;

    // Initialize state with value from localStorage or initialValue
    const [storedValue, setStoredValue] = useState<T>(() => {
        try {
            const item = window.localStorage.getItem(key);
            return item ? deserializer(item) : initialValue;
        } catch (error) {
            const errorObject = error instanceof Error ? error : new Error('Failed to get localStorage item');
            onError?.(errorObject);
            return initialValue;
        }
    });

    // Update localStorage when value changes
    useEffect(() => {
        try {
            const serializedValue = serializer(storedValue);
            window.localStorage.setItem(key, serializedValue);
        } catch (error) {
            const errorObject = error instanceof Error ? error : new Error('Failed to set localStorage item');
            onError?.(errorObject);
        }
    }, [key, storedValue, serializer, onError]);

    // Handle storage events from other windows/tabs
    useEffect(() => {
        const handleStorageChange = (event: StorageEvent) => {
            if (event.key === key && event.newValue !== null) {
                try {
                    const newValue = deserializer(event.newValue);
                    setStoredValue(newValue);
                } catch (error) {
                    const errorObject = error instanceof Error ? error : new Error('Failed to parse storage event');
                    onError?.(errorObject);
                }
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, [key, deserializer, onError]);

    const removeItem = useCallback(() => {
        try {
            window.localStorage.removeItem(key);
            setStoredValue(initialValue);
        } catch (error) {
            const errorObject = error instanceof Error ? error : new Error('Failed to remove localStorage item');
            onError?.(errorObject);
        }
    }, [key, initialValue, onError]);

    return [storedValue, setStoredValue, removeItem] as const;
}
