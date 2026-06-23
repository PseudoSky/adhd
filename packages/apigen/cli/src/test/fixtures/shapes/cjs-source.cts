// Export-shape matrix fixture — Shape 6: CommonJS `module.exports = { ... }`.
//
// A `.cts` source whose exports flow through `module.exports`. The v2 extractor
// reads the object literal on the RHS and names each op by its KEY (the exported
// symbol), synthesising a stable id from the filename + symbol.

function toUpper(s: string): string {
  return s.toUpperCase()
}

function repeat(s: string, times: number): string {
  return s.repeat(times)
}

module.exports = { toUpper, repeat }
