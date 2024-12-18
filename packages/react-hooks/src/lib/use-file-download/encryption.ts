// src/hooks/useFileDownload/encryption.ts
export interface EncryptionKey {
    key: CryptoKey;
    iv: Uint8Array;
}

export async function generateEncryptionKey(password: string): Promise<EncryptionKey> {
    // Convert password to key material
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    // Generate a random salt
    const salt = window.crypto.getRandomValues(new Uint8Array(16));

    // Derive the key using PBKDF2
    const key = await window.crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );

    // Generate random IV
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    return { key, iv };
}

export async function encryptBlob(
    blob: Blob,
    password: string
): Promise<Blob> {
    try {
        // Generate encryption key and IV from password
        const { key, iv } = await generateEncryptionKey(password);

        // Convert Blob to ArrayBuffer
        const arrayBuffer = await blob.arrayBuffer();

        // Encrypt the data
        const encryptedData = await window.crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv
            },
            key,
            arrayBuffer
        );

        // Combine IV and encrypted data
        const combinedData = new Uint8Array(iv.length + encryptedData.byteLength);
        combinedData.set(iv, 0);
        combinedData.set(new Uint8Array(encryptedData), iv.length);

        // Create new Blob with encrypted data
        return new Blob([combinedData], {
            type: 'application/encrypted'
        });
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

        // Extract IV from the beginning of the data
        const iv = arrayBuffer.slice(0, 12);
        const encryptedData = arrayBuffer.slice(12);

        // Generate the same key from password
        const { key } = await generateEncryptionKey(password);

        // Decrypt the data
        const decryptedData = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: new Uint8Array(iv)
            },
            key,
            encryptedData
        );

        // Create new Blob with decrypted data
        return new Blob([decryptedData], {
            type: 'application/octet-stream'
        });
    } catch (error) {
        console.error('Decryption failed:', error);
        throw new Error('Failed to decrypt data');
    }
}
