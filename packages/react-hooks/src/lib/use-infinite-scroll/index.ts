import { RefObject, useCallback, useEffect, useRef } from 'react';

export interface UseInfiniteScrollOptions {
  onLoadMore?: () => void;
  isLoading?: boolean;
  hasMore?: boolean;
  error?: Error | null;
  options?: IntersectionObserverInit;
}

export interface UseInfiniteScrollReturn {
  ref: RefObject<HTMLElement> | RefObject<HTMLDivElement>;
  isLoading: boolean;
  hasMore: boolean;
  error: Error | null;
}

// export function useInfiniteScroll({
//   onLoadMore,
//   isLoading = false,
//   hasMore = true,
//   error = null,
//   options = {
//     threshold: 0.1,
//     rootMargin: '50px',
//   },
// }: UseInfiniteScrollOptions = {}): UseInfiniteScrollReturn {
//   const targetRef = useRef<HTMLElement>(null);
//   const observerRef = useRef<IntersectionObserver | null>(null);

//   const handleIntersection = useCallback(
//     (entries: IntersectionObserverEntry[]) => {
//       const [entry] = entries;
//       if (
//         entry?.isIntersecting &&
//         !isLoading &&
//         hasMore &&
//         !error &&
//         onLoadMore
//       ) {
//         onLoadMore();
//       }
//     },
//     [isLoading, hasMore, error, onLoadMore]
//   );

//   useEffect(() => {
//     const currentTarget = targetRef.current;

//     if (!currentTarget) {
//       return;
//     }

//     // Cleanup previous observer
//     if (observerRef.current) {
//       observerRef.current.disconnect();
//     }

//     // Create new observer
//     observerRef.current = new IntersectionObserver(handleIntersection, options);

//     // Start observing
//     observerRef.current.observe(currentTarget);

//     return () => {
//       if (observerRef.current) {
//         observerRef.current.disconnect();
//       }
//     };
//   }, [handleIntersection, options]);

//   // Handle ref changes
//   useEffect(() => {
//     const currentTarget = targetRef.current;
//     const currentObserver = observerRef.current;

//     if (currentTarget && currentObserver) {
//       currentObserver.observe(currentTarget);

//       return () => {
//         currentObserver.unobserve(currentTarget);
//       };
//     }
//   }, [targetRef.current]);

//   return {
//     ref: targetRef,
//     isLoading,
//     hasMore,
//     error,
//   };
// }

export function useInfiniteScroll({
  onLoadMore,
  isLoading = false,
  hasMore = true,
  error = null,
  options = {},
}: UseInfiniteScrollOptions = {}): UseInfiniteScrollReturn {
  const targetRef = useRef<HTMLElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [entry] = entries;
      if (entry?.isIntersecting && !isLoading && hasMore && !error && onLoadMore) {
        onLoadMore();
      }
    },
    [isLoading, hasMore, error, onLoadMore]
  );

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    // Always disconnect previous observer before creating a new one
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const observer = new IntersectionObserver(handleIntersection, {
      threshold: 0.1,
      rootMargin: '50px',
      ...options,
    });

    observer.observe(target);
    observerRef.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [handleIntersection, options]);

  return {
    ref: targetRef,
    isLoading,
    hasMore,
    error,
  };
}


// export const useInfiniteScrollPrevious = ({
//   ref,
//   hasMore,
//   onLoadMore,
// }: {
//   onLoadMore: () => any;
//   hasMore: boolean;
//   ref: RefObject<HTMLElement>;
// }): [boolean, () => void] => {
//   const [isFetching, setIsFetching] = useState(false);
//   const handleScroll = useCallback(() => {
//     if (ref.current!.scrollTop === 0 && isFetching === false && hasMore) {
//       // starts to fetch if scrolled to top, fetching is not in progress and has more data
//       setIsFetching(true);
//     }
//   }, [ref, isFetching, hasMore]);

//   useEffect(() => {
//     const elem = ref.current;

//     if (!elem) {
//       return;
//     }

//     elem.addEventListener('scroll', handleScroll);

//     return () => {
//       elem!.removeEventListener('scroll', handleScroll);
//     };
//   }, [ref, handleScroll]);

//   // loads more if fetching has started
//   useEffect(() => {
//     if (isFetching) {
//       onLoadMore();
//     }
//   }, [isFetching, onLoadMore]);

//   const stopFetching = useCallback(() => {
//     setIsFetching(false);
//   }, []);

//   return [isFetching, stopFetching];
// };




export default useInfiniteScroll;
