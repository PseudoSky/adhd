export interface EncryptionKey {
    key: CryptoKey;
    iv: Uint8Array;
    salt: Uint8Array;
}

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const HEADER_LENGTH = SALT_LENGTH + IV_LENGTH;

async function deriveKey(
    password: string,
    salt: Uint8Array,
    usages: KeyUsage[] = ['encrypt', 'decrypt']
): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: new Uint8Array(salt) as Uint8Array<ArrayBuffer>,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        usages
    );
}

export async function generateEncryptionKey(password: string): Promise<EncryptionKey> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(password, salt);
    return { key, iv, salt };
}

export async function encryptBlob(
    blob: Blob,
    password: string
): Promise<Blob> {
    try {
        const { key, iv, salt } = await generateEncryptionKey(password);
        const arrayBuffer = await blob.arrayBuffer();

        const encryptedData = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) as Uint8Array<ArrayBuffer> },
            key,
            arrayBuffer
        );

        // Layout: [salt (16)] [iv (12)] [ciphertext (...)]
        const combined = new Uint8Array(HEADER_LENGTH + encryptedData.byteLength);
        combined.set(salt, 0);
        combined.set(iv, SALT_LENGTH);
        combined.set(new Uint8Array(encryptedData), HEADER_LENGTH);

        return new Blob([combined], { type: 'application/encrypted' });
    } catch (error) {
        console.error('Encryption failed:', error);
        throw new Error('Failed to encrypt data');
    }
}

export async function decryptBlob(
    encryptedBlob: Blob,
    password: string
): Promise<Blob> {
    try {
        const arrayBuffer = await encryptedBlob.arrayBuffer();

        // Extract salt, iv, and ciphertext from header
        const salt = new Uint8Array(arrayBuffer.slice(0, SALT_LENGTH));
        const iv = new Uint8Array(arrayBuffer.slice(SALT_LENGTH, HEADER_LENGTH));
        const encryptedData = arrayBuffer.slice(HEADER_LENGTH);

        // Re-derive the same key using the stored salt
        const key = await deriveKey(password, salt);

        const decryptedData = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            encryptedData
        );

        return new Blob([decryptedData], { type: 'application/octet-stream' });
    } catch (error) {
        console.error('Decryption failed:', error);
        throw new Error('Failed to decrypt data');
    }
}
