import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInfiniteScroll } from '.';

describe('useInfiniteScroll', () => {
  const mockIntersectionObserver = vi.fn();

  beforeEach(() => {
    // Mock IntersectionObserver
    mockIntersectionObserver.mockImplementation((callback) => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
    window.IntersectionObserver = mockIntersectionObserver;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default values', () => {
    const { result } = renderHook(() => useInfiniteScroll());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBe(null);
  });

  it('should create and cleanup IntersectionObserver', () => {
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();

    mockIntersectionObserver.mockImplementation(() => ({
      observe,
      unobserve,
      disconnect,
    }));

    const { unmount } = renderHook(() => useInfiniteScroll());

    expect(observe).toHaveBeenCalled();

    unmount();

    expect(disconnect).toHaveBeenCalled();
  });

  it('should call onLoadMore when intersection is observed', () => {
    const onLoadMore = vi.fn();
    let intersectionCallback: (entries: IntersectionObserverEntry[]) => void =
      mockIntersectionObserver.mockImplementation((callback) => {
        intersectionCallback = callback;
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      });

    renderHook(() =>
      useInfiniteScroll({
        onLoadMore,
        options: { threshold: 0.5 },
      })
    );

    // Simulate intersection
    intersectionCallback([
      {
        isIntersecting: true,
        target: document.createElement('div'),
      } as unknown as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).toHaveBeenCalled();
  });

  it('should not call onLoadMore when hasMore is false', () => {
    const onLoadMore = vi.fn();
    let intersectionCallback: (entries: IntersectionObserverEntry[]) => void =
      mockIntersectionObserver.mockImplementation((callback) => {
        intersectionCallback = callback;
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      });

    renderHook(() =>
      useInfiniteScroll({
        onLoadMore,
        hasMore: false,
      })
    );

    // Simulate intersection
    intersectionCallback([
      {
        isIntersecting: true,
        target: document.createElement('div'),
      } as unknown as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('should not call onLoadMore when isLoading is true', () => {
    const onLoadMore = vi.fn();
    let intersectionCallback: (entries: IntersectionObserverEntry[]) => void =
      mockIntersectionObserver.mockImplementation((callback) => {
        intersectionCallback = callback;
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      });

    renderHook(() =>
      useInfiniteScroll({
        onLoadMore,
        isLoading: true,
      })
    );

    // Simulate intersection
    intersectionCallback([
      {
        isIntersecting: true,
        target: document.createElement('div'),
      } as unknown as IntersectionObserverEntry,
    ]);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('should handle custom root margin', () => {
    const customRootMargin = '20px';
    const observe = vi.fn();

    mockIntersectionObserver.mockImplementation(() => ({
      observe,
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    renderHook(() =>
      useInfiniteScroll({
        options: { rootMargin: customRootMargin },
      })
    );

    expect(mockIntersectionObserver).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ rootMargin: customRootMargin })
    );
  });

  it('should handle error state', () => {
    const error = new Error('Test error');
    const { result } = renderHook(() =>
      useInfiniteScroll({
        error,
      })
    );

    expect(result.current.error).toBe(error);
  });

  it('should update ref element when provided', () => {
    const observe = vi.fn();
    const unobserve = vi.fn();

    mockIntersectionObserver.mockImplementation(() => ({
      observe,
      unobserve,
      disconnect: vi.fn(),
    }));

    const { result } = renderHook(() => useInfiniteScroll());

    const element = document.createElement('div');
    // @ts-ignore-next-line
    result.current.ref.current = element;

    // Simulate effect cleanup and re-run
    // @ts-ignore-next-line
    result.current.ref.current = null;

    expect(unobserve).toHaveBeenCalledWith(element);
  });
});
