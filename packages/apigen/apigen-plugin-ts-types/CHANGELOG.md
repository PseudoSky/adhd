## 0.0.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))
- **apigen-plugin-ts-types:** pin core-client as ^0.3.0, matching all 13 sibling plugins ([cbcca593](https://github.com/PseudoSky/adhd/commit/cbcca593))
- **apigen:** harden ts-types emitter string-literal and null-union edge cases ([d03c43b4](https://github.com/PseudoSky/adhd/commit/d03c43b4))

### ❤️ Thank You

- parity-harness-self-test
- pseudosky

# Changelog

## 0.0.1 (2026-08-02)

- Initial release: generate-only `ts-types` output target (FEAT-APIGEN-TS-TYPE-CODEGEN-001).
  - Hand-rolled JSON-Schema → TS type-declaration emitter (no runtime deps beyond
    `@adhd/apigen-core-client`, `@adhd/apigen-engine-naming`, `node:path`).
  - One `.ts` file per exported function per package, package-qualified named types
    (`DispatchCliValidateInput`), `pkg.schemas` fallback with `data`-wrapper dissolve.
  - Discriminated unions (`oneOf` + `discriminator`) emit a named union with per-branch
    interfaces retaining the discriminant; unsupported constructs reject with a clear error.
