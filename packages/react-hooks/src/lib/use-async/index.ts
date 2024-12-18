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
type AsyncWithProps<Props extends unknown[], Data> = (...args: Props) => Data
type AsyncFunc<Props extends unknown[], Data> = AsyncWithProps<Props, Data> | AsyncNoProps<Data>

export function useAsync<T extends AsyncFunc<any[], any>, Props extends Parameters<T>, Data extends ReturnType<T>>(
    asyncFunction: AsyncWithProps<Props, Data> | AsyncNoProps<Data>,
    options: UseAsyncOptions<Props, Data> = {}
) {

    const [state, setState] = useState<AsyncState<Data>>({
        status: 'idle',
        data: undefined,
        error: undefined
    });

    const execute = useCallback(async (...args: Props) => {
        setState({ status: 'pending', data: undefined, error: undefined });

        try {
            const response = args ? (await asyncFunction(...args)) : (await asyncFunction()) as Data;
            setState({ status: 'success', data: response, error: undefined });
            options.onSuccess?.(response);
            return response;
        } catch (error) {
            const errorObject = error instanceof Error ? error : new Error('An error occurred');
            setState({ status: 'error', data: undefined, error: errorObject });
            if (options.onError) {
                options.onError(errorObject);
            } else {
                throw errorObject;
            }
        }
    }, [asyncFunction, options]);

    useEffect(() => {
        if (options.immediate) {
            execute(...(options.variables || [] as Props));
        }
    }, [options.variables]);

    return {
        execute,
        status: state.status,
        data: state.data,
        error: state.error,
        isLoading: state.status === 'pending',
        isSuccess: state.status === 'success',
        isError: state.status === 'error'
    };
}
