// src/lib/use-file-download/index.ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import { compressBlob } from './compression';
import { encryptBlob } from './encryption';
export type FileType = 'json' | 'csv' | 'excel';

export interface ValidationOptions {
    maxSize?: number;
    allowedTypes?: FileType[];
    schema?: Record<string, any>;
}

export interface FileDownloadOptions {
    compression?: boolean;
    encryption?: {
        enabled: boolean;
        password?: string;
    };
    csv?: {
        delimiter?: string;
        header?: boolean;
        quotes?: boolean;
    };
    excel?: {
        sheetName?: string;
        headerStyle?: any; // XLSX.CellStyle when xlsx is loaded
        password?: string;
    };
    validation?: ValidationOptions;
    onProgress?: (progress: number) => void;
    onError?: (error: Error) => void;
    onSuccess?: (result: { url: string; size: number }) => void;
}

export interface UseFileDownloadProps {
    data: any;
    fileName?: string;
    options?: FileDownloadOptions;
}

export interface DownloadProgress {
    status: 'idle' | 'loading' | 'processing' | 'success' | 'error';
    progress: number;
    error?: Error | null;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const CHUNK_SIZE = 1000; // Process 1000 records at a time

const validateData = (
    data: any,
    options?: ValidationOptions
): { isValid: boolean; errors: string[] } => {
    const errors: string[] = [];

    if (!data) {
        errors.push('No data provided');
        return { isValid: false, errors };
    }

    const size = new Blob([JSON.stringify(data)]).size;
    if (options?.maxSize && size > options.maxSize) {
        errors.push(`File size exceeds ${options.maxSize} bytes`);
    }

    if (options?.schema) {
        try {
            Object.entries(options.schema).forEach(([key, type]) => {
                if (Array.isArray(data)) {
                    if (data.some(item => typeof item[key] !== type)) {
                        errors.push(`Invalid type for field "${key}"`);
                    }
                } else if (typeof data[key] !== type) {
                    errors.push(`Invalid type for field "${key}"`);
                }
            });
        } catch (error: any) {
            errors.push(`Schema validation failed: ${error.message}`);
        }
    }

    return { isValid: errors.length === 0, errors };
};

export const useFileDownload = ({
    data,
    fileName = 'download',
    options = {}
}: UseFileDownloadProps) => {
    const [downloadState, setDownloadState] = useState<DownloadProgress>({
        status: 'idle',
        progress: 0,
        error: null
    });

    // Cache for processed files
    const cache = useMemo(() => new Map<string, Blob>(), []);

    // Optional Web Worker for large datasets
    // const worker = useMemo(() => {
    //     if (typeof Worker !== 'undefined' && new Blob([JSON.stringify(data)]).size > MAX_FILE_SIZE) {
    //         return new Worker(new URL('./download.worker.ts', import.meta.url));
    //     }
    //     return null;
    // }, [data]);

    const worker = useMemo(() => {
        if (typeof Worker !== 'undefined' && new Blob([JSON.stringify(data)]).size > MAX_FILE_SIZE) {
            const workerInstance = new Worker(new URL('./worker.ts', import.meta.url));

            // Set up message handler
            // WorkerMessage from worker is typed different
            workerInstance.onmessage = (event: MessageEvent<any>) => {
                const { status, progress, result, error } = event.data;

                if (status === 'progress') {
                    setDownloadState(prev => ({ ...prev, progress, status: 'processing' }));
                    options.onProgress?.(progress);
                } else if (status === 'error') {
                    setDownloadState({ status: 'error', progress: 0, error: new Error(error) });
                    options.onError?.(new Error(error));
                } else if (status === 'complete') {
                    const blob = new Blob([result.data], { type: result.type });
                    cache.set(result.cacheKey, blob);
                    processDownload(blob, result.fileType);
                }
            };

            return workerInstance;
        }
        return null;
    }, [data, options.onProgress, options.onError]);

    // Cleanup function
    useEffect(() => {
        return () => {
            cache.clear();
            worker?.terminate();
        };
    }, [worker, cache]);

    const processChunk = useCallback(async (chunk: any[], fileType: FileType): Promise<Blob> => {
        switch (fileType) {
            case 'csv':
                const csvContent = await convertToCSV(chunk, options.csv);
                return new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

            case 'excel':
                const XLSX = await import('xlsx');
                const worksheet = XLSX.utils.json_to_sheet(chunk);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, options.excel?.sheetName || 'Sheet1');
                const content = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
                return new Blob([content], {
                    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                });

            default:
                return new Blob([JSON.stringify(chunk, null, 2)], {
                    type: 'application/json;charset=utf-8;'
                });
        }
    }, [options]);

    const convertToCSV = useCallback((data: any[], csvOptions?: FileDownloadOptions['csv']): string => {
        if (!Array.isArray(data) || !data.length) return '';

        const delimiter = csvOptions?.delimiter || ',';
        const useQuotes = csvOptions?.quotes !== false;
        const includeHeader = csvOptions?.header !== false;

        const headers = Object.keys(data[0]);
        const csvRows = [];

        if (includeHeader) {
            csvRows.push(headers.join(delimiter));
        }

        csvRows.push(
            ...data.map(row =>
                headers.map(header => {
                    const cell = row[header];
                    const value = typeof cell === 'object' ? JSON.stringify(cell) : cell;
                    return useQuotes ? `"${String(value).replace(/"/g, '""')}"` : String(value);
                }).join(delimiter)
            )
        );

        return csvRows.join('\n');
    }, []);

    // Async await for queueing
    const processLargeData = useCallback(async (data: any[], fileType: FileType): Promise<Blob> => {
        const chunks: any[][] = [];
        const totalChunks = Math.ceil(data.length / CHUNK_SIZE);

        // Split data into chunks
        for (let i = 0; i < data.length; i += CHUNK_SIZE) {
            chunks.push(data.slice(i, i + CHUNK_SIZE));
        }

        let processedChunks: Blob[] = [];

        // Process chunks with progress tracking (0-90%)
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const processedChunk = await processChunk(chunk, fileType);
            processedChunks.push(processedChunk);

            const progress = Math.floor((i / totalChunks) * 90);
            setDownloadState(prev => ({ ...prev, progress }));
            options.onProgress?.(progress);
        }

        return new Blob(processedChunks, { type: processedChunks[0].type });
    }, [processChunk, options]);


    // src/lib/use-file-download/index.ts
    const downloadFile = useCallback(async (fileType: FileType = 'json') => {
        const startTime = performance.now();
        setDownloadState({ status: 'loading', progress: 0, error: null });

        try {
            const validation = validateData(data, options.validation);
            if (!validation.isValid) {
                throw new Error(validation.errors.join(', '));
            }

            const cacheKey = `${JSON.stringify(data)}_${fileType}_${JSON.stringify(options)}`;
            let blob: Blob;

            // Initial data processing (0-90%)
            if (cache.has(cacheKey)) {
                setDownloadState(prev => ({ ...prev, progress: 90 }));
                options.onProgress?.(90);
                blob = cache.get(cacheKey)!;
            } else {
                setDownloadState(prev => ({ ...prev, status: 'processing' }));

                if (Array.isArray(data) && data.length > CHUNK_SIZE && worker && fileType != 'excel') {
                    // Use Web Worker for large datasets
                    worker.postMessage({
                        data,
                        fileType,
                        options,
                        cacheKey
                    });
                    // The worker will handle the rest through its message handler
                    return;
                } else if (Array.isArray(data) && data.length > CHUNK_SIZE) {
                    blob = await processLargeData(data, fileType);
                } else {
                    setDownloadState(prev => ({ ...prev, progress: 90 }));
                    options.onProgress?.(90);
                    blob = await processChunk(Array.isArray(data) ? data : [data], fileType);
                }

                cache.set(cacheKey, blob);
            }

            // Post-processing phase (90-95%)
            setDownloadState(prev => ({ ...prev, progress: 92, status: 'processing' }));
            options.onProgress?.(92);
            let compressed = false;
            // Compression phase (if enabled) (95-97%)
            if (options.compression) {
                setDownloadState(prev => ({ ...prev, progress: 95, status: 'processing' }));
                options.onProgress?.(95);

                try {
                    const compressedBlob = await compressBlob(blob);
                    if (compressedBlob.size < blob.size) {
                        blob = compressedBlob;
                        compressed = true;
                    } else {
                        console.warn('Compression resulted in larger file, using original');
                    }
                } catch (compressionError) {
                    console.warn('Compression failed, using original:', compressionError);
                }
            }

            // Encryption phase (if enabled) (97-99%)
            if (options.encryption?.enabled && options.encryption.password) {
                setDownloadState(prev => ({ ...prev, progress: 97 }));
                options.onProgress?.(97);
                const encryptedBlob = await encryptBlob(blob, options.encryption.password);
                blob = encryptedBlob;
            }

            // Final download preparation (99%)
            setDownloadState(prev => ({ ...prev, progress: 99 }));
            options.onProgress?.(99);

            // Create and trigger download
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;

            // Set proper extension
            const extensions: string[] = [fileType];
            if (compressed) {
                extensions.push('gz');
            }
            if (options.encryption?.enabled) {
                extensions.push('enc');
            }
            link.download = `${fileName}.${extensions.join('.')}`;

            // Perform download
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            const result = { url, size: blob.size };

            // Only set to 100% after everything is complete
            setDownloadState({ status: 'success', progress: 100, error: null });
            options.onSuccess?.(result);

            return result;
        } catch (error) {
            const errorObject = error instanceof Error ? error : new Error('Download failed');
            setDownloadState({ status: 'error', progress: 0, error: errorObject });
            options.onError?.(errorObject);
            throw errorObject;
        }
    }, [data, fileName, options, cache, processLargeData, processChunk, worker]);

    // Add this helper function to handle the final download steps
    const processDownload = async (blob: Blob, fileType: FileType) => {
        // Post-processing phase (90-95%)
        setDownloadState(prev => ({ ...prev, progress: 92, status: 'processing' }));
        options.onProgress?.(92);

        // Compression and encryption phases...
        // (Keep your existing compression and encryption logic here)

        // Create and trigger download
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${fileName}.${fileType}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        const result = { url, size: blob.size };

        setDownloadState({ status: 'success', progress: 100, error: null });
        options.onSuccess?.(result);

        return result;
    };

    return {
        downloadFile,
        status: downloadState.status,
        progress: downloadState.progress,
        error: downloadState.error,
        isLoading: downloadState.status === 'loading' || downloadState.status === 'processing'
    };
};
