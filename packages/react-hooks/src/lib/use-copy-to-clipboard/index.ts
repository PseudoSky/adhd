
// src/hooks/useCopyToClipboard/useCopyToClipboard.ts
import { useCallback, useState } from 'react';

export interface CopyToClipboardState {
    copied: boolean;
    error: Error | null;
}

export interface UseCopyToClipboardOptions {
    successDuration?: number;
    onSuccess?: () => void;
    onError?: (error: Error) => void;
}

export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
    const {
        successDuration = 2000,
        onSuccess,
        onError
    } = options;

    const [state, setState] = useState<CopyToClipboardState>({
        copied: false,
        error: null,
    });

    const copyToClipboard = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setState({ copied: true, error: null });
            onSuccess?.();

            // Reset copied status after specified duration
            setTimeout(() => {
                setState(prev => ({ ...prev, copied: false }));
            }, successDuration);

            return true;
        } catch (error) {
            const errorObject = error instanceof Error ? error : new Error('Copy failed');
            setState({ copied: false, error: errorObject });
            onError?.(errorObject);
            return false;
        }
    }, [successDuration, onSuccess, onError]);

    return {
        ...state,
        copyToClipboard
    };
}