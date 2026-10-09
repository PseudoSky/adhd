# Vendored @adhd/sox-telemetry (release-blocking)

Ticket c536ce29 (TRC-AC21). The owner asked for the sox tracing library to be improved to handle
logging. The improved library (`@adhd/sox-telemetry` 0.5.0: raw log channel, redaction, body
capture, log context) is **not published**, and publishing is out of scope for now.

## Mechanism

- Tarball: `packages/agent/agent-plugin-tracing/vendor/adhd-sox-telemetry-0.4.2-logchannel.03a776c8.tgz`
  (sha256 `ed4a2e5ef79460344b1067b9d71d2e4161c584f39a97a67119e627dd6b4b29a1`). It carries the
  version string 0.4.2 (same as the published npm artifact, different bytes), so it is renamed to
  never be mistaken for it.
- `packages/agent/agent-plugin-tracing/package.json` points at it with a `file:` specifier;
  `pnpm-lock.yaml` pins the bytes by integrity hash. Scoped to this ONE package: backlog and
  apigen-* remain on npm 0.4.1.
- `@adhd/agent-plugin-tracing` re-exports the new API from its index, so `@adhd/agent-mcp` consumes
  it through that package only.
- Two copies of sox-telemetry can coexist in one process; ADR-0018's `globalThis` slot is designed
  for this.

## Release-blocked

`@adhd/agent-plugin-tracing`, and every dependent that releases with it (e.g. `@adhd/agent-mcp`),
**must not be released** until `@adhd/sox-telemetry@0.5.0` is published from the sox repo.

Fails by design until then:

- `check-release-ranges` and `check-published-parity` (a `file:` spec does not resolve on npm)
- `nx release publish` of those packages (a published package would ship an uninstallable dependency)

Install, build, lint, typecheck, test, and `verify-dist-load` all work from a fresh checkout.

## Unblock (task V2, not yet scheduled)

1. Owner publishes `@adhd/sox-telemetry@0.5.0` from the sox repo.
2. Set `"@adhd/sox-telemetry": "^0.5.0"` in the tracing package, delete `vendor/`.
3. `corepack pnpm install`, then re-run `nx affected -t lint,typecheck,typecheck-spec,test,build,verify-dist-load`.
