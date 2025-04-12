// download.worker.ts

export type WorkerMessage = {
    data: any[];
    fileType: 'json' | 'csv' | 'excel';
    options: any;
    cacheKey: string;
}

const CHUNK_SIZE = 1000;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const { data, fileType, options, cacheKey } = event.data;

    try {
        const result = await processLargeData(data, fileType, options);
        self.postMessage({
            status: 'complete',
            result: {
                data: result.data,
                type: result.type,
                fileType,
                cacheKey
            }
        });
    } catch (error) {
        self.postMessage({
            status: 'error',
            error: error instanceof Error ? error.message : 'Processing failed'
        });
    }
};

async function processLargeData(
    data: any[],
    fileType: 'json' | 'csv' | 'excel',
    options: any
) {
    const chunks: any[][] = [];
    const totalChunks = Math.ceil(data.length / CHUNK_SIZE);

    // Split data into chunks
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
        chunks.push(data.slice(i, i + CHUNK_SIZE));
    }

    let processedChunks: any[] = [];

    // Process each chunk
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const processedChunk = await processChunk(chunk, fileType, options);
        processedChunks.push(processedChunk);

        // Report progress back to main thread
        const progress = Math.floor((i / totalChunks) * 90);
        self.postMessage({ status: 'progress', progress });
    }

    // Combine processed chunks
    return combineChunks(processedChunks, fileType);
}

async function processChunk(
    chunk: any[],
    fileType: 'json' | 'csv' | 'excel',
    options: any
) {
    switch (fileType) {
        case 'csv':
            return convertToCSV(chunk, options.csv);
        case 'excel':
            // Note: XLSX operations should be handled in main thread
            // as Web Workers don't have direct access to external modules
            return JSON.stringify(chunk);
        default:
            return JSON.stringify(chunk, null, 2);
    }
}

function convertToCSV(data: any[], csvOptions?: any): string {
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
}

function combineChunks(chunks: any[], fileType: 'json' | 'csv' | 'excel') {
    let type: string;
    let data: any;

    switch (fileType) {
        case 'csv':
            type = 'text/csv;charset=utf-8;';
            // For CSV, we need to keep only one header
            data = chunks[0].split('\n')[0] + '\n' +
                chunks.map(chunk =>
                    chunk.split('\n').slice(1).join('\n')
                ).join('\n');
            break;
        case 'excel':
            type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            data = JSON.parse('[' + chunks.join(',') + ']');
            break;
        default:
            type = 'application/json;charset=utf-8;';
            data = '[' + chunks.join(',') + ']';
    }

    return { data, type };
}

// Required for TypeScript to recognize this as a module
// export { };

