// useInfiniteScroll.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { RefObject, useCallback, useState } from 'react';
import { useInfiniteScroll } from '.';

const meta: Meta = {
  title: 'Hooks/useInfiniteScroll',
  tags: ['autodocs'],
};

export default meta;

function InfiniteList() {
  const [items, setItems] = useState<string[]>(
    Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`)
  );
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadMore = useCallback(async () => {
    try {
      setIsLoading(true);
      // Simulate API delay
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const lastItem = parseInt(items[items.length - 1].split(' ')[1]);
      const newItems = Array.from(
        { length: 10 },
        (_, i) => `Item ${lastItem + i + 1}`
      );

      setItems((prev) => [...prev, ...newItems]);
      setHasMore(lastItem < 50); // Stop at 50 items
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to load more items')
      );
    } finally {
      setIsLoading(false);
    }
  }, [items]);

  const { ref } = useInfiniteScroll({
    onLoadMore: loadMore,
    isLoading,
    hasMore,
    error,
    options: {
      threshold: 0.5,
      rootMargin: '100px',
    },
  });

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium">
        Scroll down to load more items (max: 50)
      </div>
      <div className="h-[400px] overflow-y-auto border rounded">
        <div className="space-y-2 p-4">
          {items.map((item, index) => (
            <div key={index} className="p-4 bg-gray-100 rounded">
              {item}
            </div>
          ))}
          <div ref={ref as RefObject<HTMLDivElement>} className="h-4">
            {isLoading && (
              <div className="text-center text-gray-600">Loading...</div>
            )}
            {error && (
              <div className="text-center text-red-600">
                Error: {error.message}
              </div>
            )}
            {!hasMore && (
              <div className="text-center text-gray-600">
                No more items to load
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Status:</div>
        <div className="space-y-1">
          <div>Items: {items.length}</div>
          <div>Loading: {isLoading ? 'Yes' : 'No'}</div>
          <div>Has more: {hasMore ? 'Yes' : 'No'}</div>
          <div>Error: {error ? error.message : 'None'}</div>
        </div>
      </div>
    </div>
  );
}

export const Basic: StoryObj = {
  render: () => <InfiniteList />,
};

// ErrorExample story for useInfiniteScroll
function InfiniteListWithError() {
  const [items, setItems] = useState<string[]>(
    Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`)
  );
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadMore = useCallback(async () => {
    try {
      setIsLoading(true);
      await new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error('Failed to fetch data')), 1000)
      );
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to load more items')
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const { ref } = useInfiniteScroll({
    onLoadMore: loadMore,
    isLoading,
    hasMore,
    error,
  });

  return (
    <div className="h-[400px] overflow-y-auto border rounded">
      <div className="space-y-2 p-4">
        {items.map((item, index) => (
          <div key={index} className="p-4 bg-gray-100 rounded">
            {item}
          </div>
        ))}
        <div ref={ref as RefObject<HTMLDivElement>} className="h-4">
          {isLoading && (
            <div className="text-center text-gray-600">Loading...</div>
          )}
          {error && (
            <div className="text-center text-red-600">
              Error: {error.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const WithError: StoryObj = {
  render: () => <InfiniteListWithError />,
};
