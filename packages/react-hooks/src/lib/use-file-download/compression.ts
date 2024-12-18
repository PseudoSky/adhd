// Utility function to convert Blob to ArrayBuffer
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });
}

// Optional: Add utility function to check if a blob is compressed
export function isCompressedBlob(blob: Blob): boolean {
    return blob.type === 'application/gzip';
}

// Optional: Add utility function to check browser compatibility
export function isCompressionSupported(): boolean {
    return typeof CompressionStream !== 'undefined' &&
        typeof DecompressionStream !== 'undefined';
}
// Polyfill check and warning
if (!isCompressionSupported()) {
    console.warn(
        'CompressionStream/DecompressionStream is not supported in this environment. ' +
        'Compression operations will fall back to uncompressed data.'
    );
}

export async function compressBlob(blob: Blob): Promise<Blob> {
    try {
        // Check if CompressionStream is supported
        if (typeof CompressionStream === 'undefined') {
            console.warn('CompressionStream not supported, returning original blob');
            return blob;
        }

        // Create a new ReadableStream from the blob
        const stream = new Response(blob).body;
        if (!stream) {
            throw new Error('Failed to create stream from blob');
        }

        // Create compression stream and pipe the data through it
        const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));

        // Convert the compressed stream back to a blob with proper type
        const compressedBlob = await new Response(compressedStream).blob();

        // Create new blob with correct type
        return new Blob([compressedBlob], {
            type: 'application/gzip'
        });
    } catch (error) {
        console.error('Compression failed:', error);
        return blob; // Fallback to original blob
    }
}


export async function decompressBlob(blob: Blob): Promise<Blob> {
    try {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('DecompressionStream not supported');
        }

        const stream = new Response(blob).body;
        if (!stream) {
            throw new Error('Failed to create stream from blob');
        }

        const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
        return new Response(decompressedStream).blob();
    } catch (error) {
        throw new Error(`Decompression failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
