import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebounce } from '.';

describe('useDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('should return initial value immediately', () => {
    const initialValue = 'initial';
    const { result } = renderHook(() => useDebounce(initialValue, 500));
    const [value] = result.current;

    expect(value).toBe(initialValue);
  });

  it('should not update value before delay', () => {
    const initialValue = 'initial';
    const { result } = renderHook(() => useDebounce(initialValue, 500));
    const [, setValue] = result.current;

    setValue('updated');

    const [value] = result.current;
    expect(value).toBe(initialValue);
  });

  it('should update value after delay', async () => {
    const initialValue = 'initial';
    const { result } = renderHook(() => useDebounce(initialValue, 500));
    const [, setValue] = result.current;

    setValue('updated');

    // Fast-forward time by 500ms
    await vi.advanceTimersByTimeAsync(500);

    const [value] = result.current;

    await waitFor(
      () => {
        expect(value).toBe('updated');
      },
      { timeout: 1000 }
    );
  });

  it('should cancel previous timeout when value changes rapidly', async () => {
    const { result } = renderHook(() => useDebounce('initial', 500));
    const [, setValue] = result.current;

    setValue('first update');

    // Advance time partially
    vi.advanceTimersByTime(200);

    setValue('second update');

    // Advance time to just before the second delay would complete
    vi.advanceTimersByTime(499);

    // First update should not be reflected
    expect(result.current[0]).toBe('initial');

    // Complete the delay
    vi.advanceTimersByTime(1);

    // Should show the second update
    await waitFor(
      () => {
        expect(result.current[0]).toBe('second update');
      },
      { timeout: 1000 }
    );
  });

  it('should handle undefined delay', async () => {
    const initialValue = 'initial';
    const { result } = renderHook(() => useDebounce(initialValue, undefined));

    act(() => {
      result.current[1]('updated');
    });

    vi.advanceTimersByTime(0);

    await waitFor(() => {
      expect(result.current[0]).toBe('updated');
    });
  });

  it('should handle null value', () => {
    const { result } = renderHook(() => useDebounce(null, 500));
    const [value] = result.current;
    expect(value).toBe(null);
  });

  it('should cleanup timeout on unmount', () => {
    const { result, unmount } = renderHook(() => useDebounce('initial', 500));
    const [, setValue] = result.current;

    setValue('updated');

    unmount();

    // Advance timers and verify no errors occur
    vi.advanceTimersByTime(500);
  });
});
