import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileDownload } from './';

// Mock XLSX module
vi.mock('xlsx', () => ({
  default: {
    utils: {
      json_to_sheet: vi.fn(),
      book_new: vi.fn(() => ({})),
      book_append_sheet: vi.fn(),
    },
    write: vi.fn(() => new Uint8Array()),
  },
}));

describe('useFileDownload', () => {
  // Mock setup
  const mockCreateObjectURL = vi.fn();
  const mockRevokeObjectURL = vi.fn();
  const mockAppendChild = vi.fn();
  const mockRemoveChild = vi.fn();
  const mockClick = vi.fn();

  beforeEach(() => {
    // Setup mocks
    global.URL.createObjectURL = mockCreateObjectURL;
    global.URL.revokeObjectURL = mockRevokeObjectURL;
    document.body.appendChild = mockAppendChild;
    document.body.removeChild = mockRemoveChild;

    mockCreateObjectURL.mockReturnValue('mock-url');

    document.createElement = vi.fn().mockReturnValue({
      click: mockClick,
      href: '',
      download: '',
    });

    // Mock performance.now
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const testData = [
    { id: 1, name: 'Test 1' },
    { id: 2, name: 'Test 2' },
  ];

  it('should initialize with correct default state', () => {
    const { result } = renderHook(() => useFileDownload({ data: testData }));

    expect(result.current.status).toBe('idle');
    expect(result.current.progress).toBe(0);
    expect(result.current.error).toBe(null);
  });

  it('should handle JSON download with validation', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useFileDownload({
        data: testData,
        fileName: 'test',
        options: {
          validation: {
            schema: {
              id: 'number',
              name: 'string',
            },
          },
          onSuccess,
        },
      })
    );

    await act(async () => {
      await result.current.downloadFile('json');
    });

    expect(result.current.status).toBe('success');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('should handle validation errors', async () => {
    const onError = vi.fn();
    const invalidData = [{ id: 'not-a-number', name: 123 }]; // Invalid types

    const { result } = renderHook(() =>
      useFileDownload({
        data: invalidData,
        options: {
          validation: {
            schema: {
              id: 'number',
              name: 'string',
            },
          },
          onError,
        },
      })
    );

    await act(async () => {
      await result.current.downloadFile('json');
    });

    expect(result.current.status).toBe('error');
    expect(onError).toHaveBeenCalled();
  });

  it('should handle large datasets with chunking', async () => {
    const largeData = Array.from({ length: 2000 }, (_, i) => ({
      id: i,
      name: `Test ${i}`,
    }));

    const onProgress = vi.fn();
    const { result } = renderHook(() =>
      useFileDownload({
        data: largeData,
        options: { onProgress },
      })
    );

    await act(async () => {
      await result.current.downloadFile('csv');
    });

    expect(onProgress).toHaveBeenCalled();
    expect(result.current.status).toBe('success');
  });

  it('should use cache for repeated downloads', async () => {
    const { result } = renderHook(() =>
      useFileDownload({
        data: testData,
      })
    );

    await act(async () => {
      await result.current.downloadFile('json');
      await result.current.downloadFile('json'); // Second call should use cache
    });

    expect(mockCreateObjectURL).toHaveBeenCalledTimes(2);
  });

  it('should handle compression option', async () => {
    const { result } = renderHook(() =>
      useFileDownload({
        data: testData,
        options: { compression: true },
      })
    );

    await act(async () => {
      await result.current.downloadFile('json');
    });

    expect(result.current.status).toBe('success');
  });

  it('should handle encryption option', async () => {
    const { result } = renderHook(() =>
      useFileDownload({
        data: testData,
        options: {
          encryption: {
            enabled: true,
            password: 'test-password',
          },
        },
      })
    );

    await act(async () => {
      await result.current.downloadFile('json');
    });

    expect(result.current.status).toBe('success');
  });

  it('should retry failed downloads', async () => {
    const mockError = new Error('Download failed');
    mockCreateObjectURL.mockImplementationOnce(() => {
      throw mockError;
    });

    const { result } = renderHook(() =>
      useFileDownload({
        data: testData,
      })
    );

    await act(async () => {
      await result.current.downloadFile('json');
    });

    expect(mockCreateObjectURL).toHaveBeenCalledTimes(2); // Original + 1 retry
    expect(result.current.status).toBe('success');
  });

  it('should cleanup resources on unmount', () => {
    const { unmount } = renderHook(() =>
      useFileDownload({
        data: testData,
      })
    );

    unmount();

    // Add assertions for cleanup if you have exposed ways to check it
  });
});
