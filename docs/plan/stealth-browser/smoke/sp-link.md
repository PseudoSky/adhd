# sp-link evidence

REGISTRY: not published
`npm view @adhd/sox-service-proxy@0.6.0 version` exit=1 (E404 No match found for version 0.6.0)

Override mechanism: pnpm 8.15.9 accepted a `file:` tarball as a `pnpm.overrides` value (proved in a scratch manifest with `pnpm install --lockfile-only`, then applied to the root package.json). No FALLBACK needed.

TARBALL_PATH: /Users/nix/.cache/adhd-dev-tarballs/adhd-sox-service-proxy-0.6.0-61d3ed54-prerelease.tgz
TARBALL_SHA256: 61d3ed5468a461a7e2b81f3bc72b0bfd2075f9e97f2adcd957cd4f5ed118137b
TARBALL_VERSION: 0.6.0
TARBALL_BUILD: pnpm pack
Source: sox-ecosystem sp-lifecycle HEAD 9848308b (file copied to a sha256[:8]-named path; bytes identical to adhd-sox-service-proxy-0.6.0-9848308b-prerelease.tgz).

Install: `pnpm install --ignore-scripts --prefer-offline` (pnpm 8.15.9) in the worktree; node_modules/@adhd/sox-service-proxy/package.json version 0.6.0.
