/** The shape the specs read off a rejection (ApiError, GatewayError details, McpError). */
export interface ICaught {
  code?: string | number;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Awaits a promise that MUST reject and returns the rejection typed for assertions. A promise that
 * resolves fails the test loudly instead of letting the following assertions read `undefined`.
 */
export async function caught(promise: Promise<unknown>): Promise<ICaught> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (e: unknown) => e as ICaught
  );
}
