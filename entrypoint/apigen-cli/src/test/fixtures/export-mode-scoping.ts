// Fixture for BUG-APIGEN-034 regression tests — `--export <mode>` scoping.
//
// Mirrors the exact scenario in the BACKLOG entry: a private named-export
// helper alongside an intentionally `--export default`-scoped public object.
// `--export default` must scope the served surface to ONLY `ping`/`echo`
// (the default object's properties), excluding `internalHelper`. Omitting
// `--export` (named mode) must do the reverse.

export function internalHelper(x: number): number {
  return x + 1;
}

function ping(): string {
  return 'pong';
}

function echo(msg: string): string {
  return msg;
}

export default { ping, echo };

export const __samples__: Record<string, Record<string, unknown>> = {
  internalHelper: { x: 1 },
  ping: {},
  echo: { msg: 'hi' },
};
