# Distribution: @adhd/stealth-core-browser

Status: NOT verified as published. No registry lookup was made (no web access used); no registry version is claimed.

## Declared
- Package name: @adhd/stealth-core-browser, version in package.json: 0.1.0 (disk). publishConfig.access: public. License MIT. files: dist, CHANGELOG.md. engines.node >=22.5.
- Repository: git+https://github.com/PseudoSky/adhd.git, directory packages/stealth/stealth-core-browser (remote origin git@github.com:PseudoSky/adhd.git).
- project.json tags: publish:npm, access:public. Target nx-release-publish (packageRoot dist) depends on build, test, verify-dist-load, dist-manifest, publish-hygiene. Release config: nx.json "release" with projectsRelationship independent; version resolver git-tag with disk fallback.
- Git tags matching *stealth-core*: none found at catalog time.
- No dedicated publish workflow found for this package in .github/workflows (ci.yml, pull-request.yml, build-docker.yml, publish-embed-cdn.yml present); the publish path is the Nx release target above.

## Pipeline (derived from config, not executed)
nx release (version via git-tag/disk) -> nx-release-publish on stealth-core-browser (builds dist with vite + dts, runs test, verify-dist-load, dist-manifest, publish-hygiene).

## Consumers
@adhd/stealth-search (workspace sibling) projects the six verbs onto CLI and MCP (per src/api.ts header and AGENTS.md).

## Freshness
- last_catalog_sha: 2b8320c8e0be7cf5569ecd57bf9da76bae430d4b (source and tests unchanged through HEAD 3537748eb79c7303f62efa5caeb4c64603d3a1b5)
- last_catalog_at: 2026-10-24 (commit time of 2b8320c8e: 2026-10-24T14:23:54-04:00)
- commits_since: 0 on src/, test/, examples/, package.json (git diff --stat 2b8320c8e HEAD over those paths is empty); HEAD itself is 1 commit(s) later (docs only).
- Registry freshness: unknown (unverified; npm not queried).
