// Fixture for FEAT-APIGEN-022 / BUG-APIGEN-025 auto-hoist-to-GET tests.
//
// - noParams / getPrimitive: primitives-only (or zero) params — must
//   auto-hoist to GET without any `--opt http.verb.<id>=GET` override.
// - withObject / withArray: a complex-typed param — must NOT auto-hoist,
//   stays POST.

export function noParams(): string {
  return 'pong';
}

export function getPrimitive(id: string, count: number): string {
  return `${id}-${count}`;
}

export function withObject(payload: { x: number }): string {
  return String(payload.x);
}

export function withArray(ids: string[]): string {
  return ids.join(',');
}
