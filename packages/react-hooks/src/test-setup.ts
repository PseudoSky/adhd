import { cleanup } from '@testing-library/react';
import { CompressionStream, DecompressionStream } from 'node:stream/web';
import { afterEach } from 'vitest';

if (!globalThis.CompressionStream) {
  globalThis.CompressionStream = CompressionStream as any;
}
if (!globalThis.DecompressionStream) {
  globalThis.DecompressionStream = DecompressionStream as any;
}
// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Polyfill IntersectionObserver for jsdom
if (typeof window !== 'undefined' && !window.IntersectionObserver) {
  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    observe = (): void => undefined;
    unobserve = (): void => undefined;
    disconnect = (): void => undefined;
    takeRecords = (): IntersectionObserverEntry[] => [];
    constructor(
      public callback: IntersectionObserverCallback,
      public options?: IntersectionObserverInit
    ) { }
  }
  window.IntersectionObserver = MockIntersectionObserver;
}

// Polyfill Blob.arrayBuffer for jsdom
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
