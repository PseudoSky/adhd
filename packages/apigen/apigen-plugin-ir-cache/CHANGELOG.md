## 0.1.2 (2026-09-26)

### 🚀 Features

- **apigen-plugin-ir-cache:** await + durably fsync the MISS write ([fa3c583c](https://github.com/PseudoSky/adhd/commit/fa3c583c))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **apigen-plugin-ir-cache:** honest durability claim; drop no-op dir-sync branch ([b4160c77](https://github.com/PseudoSky/adhd/commit/b4160c77))
- **test:** make the full affected gate green (3 latent test-hermeticity fixes) ([734f756d](https://github.com/PseudoSky/adhd/commit/734f756d))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.1 (2026-09-24)


### 🩹 Fixes

- **apigen-plugin-ir-cache:** default the runtime IR cache to the @adhd/environment global root, keyed per source (BUG-APIGEN-058)

- **nx-build:** run-scoped release manifest token + apigen-cli readiness flake + codegen test output


### ❤️  Thank You

- pseudosky
- Sky