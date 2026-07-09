// src/hooks/useAsync/useAsync.ts
import { useCallback, useEffect, useState } from 'react';

export interface AsyncState<T> {
  status: 'idle' | 'pending' | 'success' | 'error';
  data?: T;
  error?: Error;
}

export interface UseAsyncOptions<Variables, T> {
  immediate?: boolean;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
  variables?: Variables;
}

type AsyncNoProps<Data> = () => Data;
type AsyncWithProps<Props extends unknown[], Data> = (...args: Props) => Data;
type AsyncFunc<Props extends unknown[], Data> =
  | AsyncWithProps<Props, Data>
  | AsyncNoProps<Data>;

export function useAsync<
  T extends AsyncFunc<unknown[], unknown>,
  Props extends Parameters<T>,
  Data extends ReturnType<T>
>(
  asyncFunction: AsyncWithProps<Props, Data> | AsyncNoProps<Data>,
  options: UseAsyncOptions<Props, Data> = {}
) {
  const [state, setState] = useState<AsyncState<Data>>({
    status: 'idle',
    data: undefined,
    error: undefined,
  });

  const execute = useCallback(
    async (...args: Props) => {
      setState({ status: 'pending', data: undefined, error: undefined });

      try {
        const response = args
          ? await asyncFunction(...args)
          : ((await asyncFunction()) as Data);
        setState({ status: 'success', data: response, error: undefined });
        options.onSuccess?.(response);
        return response;
      } catch (error) {
        const errorObject =
          error instanceof Error ? error : new Error('An error occurred');
        setState({ status: 'error', data: undefined, error: errorObject });
        if (options.onError) {
          options.onError(errorObject);
        } else {
          throw errorObject;
        }
      }
    },
    // `options` itself is not memoized by callers (a fresh object literal
    // per render is the common/expected usage pattern — see this hook's
    // own tests), so depending on the whole object makes `execute`
    // re-identify every render. Depend on the specific callbacks it
    // actually closes over instead, so `execute` (and therefore the
    // effect below that depends on it) stays referentially stable across
    // renders that don't change these handlers — this is what actually
    // fixes the infinite render/execute loop; simply dropping `execute`
    // from the effect's deps would silence the lint rule without fixing it.
    [asyncFunction, options.onSuccess, options.onError]
  );

  useEffect(() => {
    if (options.immediate) {
      execute(...(options.variables || ([] as Props)));
    }
  }, [options.variables, execute, options.immediate]);

  return {
    execute,
    status: state.status,
    data: state.data,
    error: state.error,
    isLoading: state.status === 'pending',
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
  };
}
