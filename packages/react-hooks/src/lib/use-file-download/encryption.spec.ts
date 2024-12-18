// src/hooks/useFileDownload/encryption.test.ts
import { describe, expect, it } from 'vitest';
import { decryptBlob, encryptBlob } from './encryption';

describe('Encryption utilities', () => {
    it('should encrypt and decrypt data correctly', async () => {
        const originalData = 'Secret data';
        const password = 'test-password';
        const originalBlob = new Blob([originalData], { type: 'text/plain' });

        // Encrypt
        const encryptedBlob = await encryptBlob(originalBlob, password);
        expect(encryptedBlob.size).toBeGreaterThan(originalBlob.size);

        // Decrypt
        const decryptedBlob = await decryptBlob(encryptedBlob, password);
        const decryptedText = await decryptedBlob.text();
        expect(decryptedText).toBe(originalData);
    });

    it('should fail decryption with wrong password', async () => {
        const originalData = 'Secret data';
        const originalBlob = new Blob([originalData], { type: 'text/plain' });
        const encryptedBlob = await encryptBlob(originalBlob, 'correct-password');

        await expect(decryptBlob(encryptedBlob, 'wrong-password'))
            .rejects.toThrow('Failed to decrypt data');
    });
});
