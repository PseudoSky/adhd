// src/hooks/useLocalStorage/useLocalStorage.test.ts
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLocalStorage } from './';

describe('useLocalStorage', () => {
    let mockStorage: { [key: string]: string } = {};

    beforeEach(() => {
        mockStorage = {};
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
            (key) => mockStorage[key] || null
        );
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
            (key, value) => { mockStorage[key] = value.toString(); }
        );
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(
            (key) => { delete mockStorage[key]; }
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should initialize with the initial value when no stored value exists', () => {
        const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));
        expect(result.current[0]).toBe('initial');
    });

    it('should initialize with the stored value when it exists', () => {
        mockStorage['test-key'] = JSON.stringify('stored value');
        const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));
        expect(result.current[0]).toBe('stored value');
    });

    it('should update the stored value when state changes', () => {
        const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

        act(() => {
            result.current[1]('new value');
        });

        expect(result.current[0]).toBe('new value');
        expect(mockStorage['test-key']).toBe(JSON.stringify('new value'));
    });

    it('should handle removing items', () => {
        const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

        act(() => {
            result.current[2]();
        });

        expect(result.current[0]).toBe('initial');
        expect(mockStorage['test-key']).toBeUndefined();
    });

    it('should use custom serializer and deserializer', () => {
        const date = new Date();
        const { result } = renderHook(() => useLocalStorage(
            'test-key',
            date,
            {
                serializer: (d: Date) => d.toISOString(),
                deserializer: (s: string) => new Date(s)
            }
        ));

        expect(result.current[0].getTime()).toBe(date.getTime());

        act(() => {
            const newDate = new Date(date.getTime() + 1000);
            result.current[1](newDate);
        });

        expect(mockStorage['test-key']).toBe(result.current[0].toISOString());
    });

    it('should handle storage events from other windows', () => {
        const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

        act(() => {
            const storageEvent = new StorageEvent('storage', {
                key: 'test-key',
                newValue: JSON.stringify('updated from other window'),
                oldValue: JSON.stringify('initial'),
                storageArea: localStorage,
            });
            window.dispatchEvent(storageEvent);
        });

        expect(result.current[0]).toBe('updated from other window');
    });

    it('should handle errors with custom error handler', () => {
        const onError = vi.fn();
        const invalidJson = '{invalid json}';
        mockStorage['test-key'] = invalidJson;

        renderHook(() => useLocalStorage('test-key', 'initial', { onError }));

        expect(onError).toHaveBeenCalled();
    });

    it('should handle function updates', () => {
        const { result } = renderHook(() => useLocalStorage('test-key', 0));

        act(() => {
            result.current[1](prev => prev + 1);
        });

        expect(result.current[0]).toBe(1);
        expect(mockStorage['test-key']).toBe(JSON.stringify(1));
    });

    it('should maintain value type', () => {
        const initialValue = { count: 0, text: 'hello' };
        const { result } = renderHook(() => useLocalStorage('test-key', initialValue));

        act(() => {
            result.current[1]({ ...initialValue, count: 1 });
        });

        expect(result.current[0]).toEqual({ count: 1, text: 'hello' });
        expect(typeof result.current[0]).toBe('object');
    });
});
