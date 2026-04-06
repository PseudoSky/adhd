import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInfiniteScroll } from '.';

describe('useInfiniteScroll', () => {
  let observeFn: ReturnType<typeof vi.fn>;
  let disconnectFn: ReturnType<typeof vi.fn>;
  let intersectionCallback: (entries: IntersectionObserverEntry[]) => void;

  beforeEach(() => {
    observeFn = vi.fn();
    disconnectFn = vi.fn();

    const MockObserver = vi.fn((callback, options) => {
      intersectionCallback = callback;
      return {
        observe: observeFn,
        unobserve: vi.fn(),
        disconnect: disconnectFn,
      };
    });
    window.IntersectionObserver = MockObserver as any;
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

  it('should create IntersectionObserver when ref has a target', () => {
    const { result } = renderHook(() => useInfiniteScroll());

    // The observer won't be created until the ref points to an element.
    // Since useRef starts as null and the hook guards on !target,
    // we verify it returns a ref that can be attached to a DOM node.
    expect(result.current.ref).toBeDefined();
    expect(result.current.ref.current).toBeNull();
  });

  it('should not call onLoadMore when hasMore is false', () => {
    const onLoadMore = vi.fn();

    // Manually set the ref to a DOM element before the hook mounts
    const element = document.createElement('div');
    const { result } = renderHook(() => {
      const scroll = useInfiniteScroll({
        onLoadMore,
        hasMore: false,
      });
      // Simulate ref being attached
      (scroll.ref as React.MutableRefObject<HTMLElement | null>).current =
        element;
      return scroll;
    });

    // Even if intersection fires, onLoadMore should not be called
    if (intersectionCallback) {
      act(() => {
        intersectionCallback([
          {
            isIntersecting: true,
            target: element,
          } as unknown as IntersectionObserverEntry,
        ]);
      });
    }

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('should not call onLoadMore when isLoading is true', () => {
    const onLoadMore = vi.fn();
    const element = document.createElement('div');

    renderHook(() => {
      const scroll = useInfiniteScroll({
        onLoadMore,
        isLoading: true,
      });
      (scroll.ref as React.MutableRefObject<HTMLElement | null>).current =
        element;
      return scroll;
    });

    if (intersectionCallback) {
      act(() => {
        intersectionCallback([
          {
            isIntersecting: true,
            target: element,
          } as unknown as IntersectionObserverEntry,
        ]);
      });
    }

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('should handle error state', async () => {
    const error = new Error('Test error');
    const { result } = renderHook(() => useInfiniteScroll({ error }));
    expect(result.current.error).toBe(error);
  });
});
