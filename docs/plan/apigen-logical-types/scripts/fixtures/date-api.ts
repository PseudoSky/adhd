// Fixture for [dod.1] — a Date param AND a Date return.
//
// Drives the FULL built bin over MCP/HTTP. The extractor must project the
// `Date` type to `{type:'string', format:'date-time'}` at both the param and
// the return position; the dispatch decode/encode seam must then deliver a real
// `Date` to the function and re-emit an RFC 3339 UTC string on the wire.
//
// `echoAt` proves the function received a REAL Date (not the wire string) by
// calling `at.getTime()` and adding a fixed offset — a plain string would throw
// or NaN here. The probe DERIVES the expected return at runtime by importing
// this module and calling `echoAt` directly with a real Date built from the
// sample, so nothing is hard-coded.

export async function echoAt(at: Date): Promise<Date> {
  // getTime() only works on a real Date — proves the decode seam fired.
  return new Date(at.getTime() + 1000);
}

export const __samples__: Record<string, Record<string, unknown>> = {
  // ISO instant sent on the wire; the probe also builds `new Date(this)` to
  // compute the in-process ground truth.
  echoAt: { at: '2026-01-02T03:04:05.678Z' },
};
