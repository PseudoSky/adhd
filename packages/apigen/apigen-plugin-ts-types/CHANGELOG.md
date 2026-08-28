# Changelog

## 0.0.1 (2026-08-02)

- Initial release: generate-only `ts-types` output target (FEAT-APIGEN-TS-TYPE-CODEGEN-001).
  - Hand-rolled JSON-Schema → TS type-declaration emitter (no runtime deps beyond
    `@adhd/apigen-core-client`, `@adhd/apigen-engine-naming`, `node:path`).
  - One `.ts` file per exported function per package, package-qualified named types
    (`DispatchCliValidateInput`), `pkg.schemas` fallback with `data`-wrapper dissolve.
  - Discriminated unions (`oneOf` + `discriminator`) emit a named union with per-branch
    interfaces retaining the discriminant; unsupported constructs reject with a clear error.
