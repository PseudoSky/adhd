// Fixture: Shape 6 — CJS source (module.exports = {...})
// ts-morph handles this when parsing TS source with CJS assignment style

function ping(): { status: string } {
  return { status: 'ok' }
}

function echo(input: string): string {
  return input
}

module.exports = { ping, echo }
