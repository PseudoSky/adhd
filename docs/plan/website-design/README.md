# @adhd Website — Design Plan

> Plan for the public-facing @adhd monorepo website. Part 1 is a **generalized playbook**
> reusable for any open-source monorepo / multi-product site; Part 2 is the **specific page
> map** for @adhd; Parts 3–8 are the concrete filesystem layout, hosting/URL plan, sync
> architecture, docs-to-update, policy changes, and follow-up checklist. Researched 2026-08-26.

## Purpose

Take @adhd from an invisible monorepo to a public, AI- and search-crawlable home that sells the
**platform**, not the catalog — a self-hosting agent operating system where agents are data, served
from one registry, on one substrate, building itself. The site is the hub every promotion channel
(Show HN, directories, comparison searches) points at.

## Research — best-in-class exemplars (live-fetched)

| Site | What it demonstrates |
|---|---|
| **Rush Stack** (rushstack.io) | Microsoft's monorepo — a thin "What's in the stack" hub + **per-package microsites** (rushjs.io, api-extractor.com, tsdoc.org) |
| **Nx** (nx.dev) | Marketing landing + docs-first; concepts / recipes / plugins / API split |
| **TanStack** (tanstack.com) | "Browse all libraries" hub + **versioned per-library docs** (`/query/latest/…`) |
| **Turborepo / Vercel / Supabase** | Docs + blog + changelog + community, consistent branding |

The winning pattern across all of them: **hub-and-spoke IA + Diátaxis docs split + install-first**.

---

## Part 1 — Generalized playbook (reusable for any monorepo/multi-product site)

### Information architecture (hub-and-spoke)

1. **Home / hub** — a "What's in the stack" page: every package/product with a one-liner + link.
   This *is* the marketing page; keep it thin.
2. **Per-package spokes** — one page (or microsite) per package, identical template.
3. **Docs, split four ways (Diátaxis)** — Getting Started → Concepts/Guides → API Reference → Recipes/Examples.
4. **Supporting** — Blog/releases, Changelog, Community, Comparison pages, Showcase/case studies.

### Per-package page template (identical for every package)

```
Name + one-line pitch
INSTALL command (first, above the fold)
5-line quickstart (copy-paste → it works)
"What/why it solves"
Links → Docs · API · GitHub · npm
Comparison link ("X vs Y")
```

### Design principles

1. **Docs-first** — the docs *is* the product surface; the landing is thin.
2. **Install-first hero** — minimize time-to-first-success; copy-paste install + example above the fold.
3. **Versioned docs** (`/latest/`) matched to package versions.
4. **Comparison pages** ("vs tsoa", "Why X") — capture the highest-intent search and establish the moat.
5. **Social proof** — user logos, GitHub stars, Discord/Discussions links.
6. **Ruthless consistency** — one layout/branding across all packages.
7. **AEO layer** — `llms.txt`, `sitemap.xml`, `SoftwareApplication` JSON-LD per package, full-text search, answer-first copy.

---

## Part 2 — @adhd-specific page map

### Home (hub)

- Hero: *"The self-hosting agent platform — agents, memory, and tooling on one substrate, served
  over every transport."* + ⭐/install CTA.
- **"The platform, by layer"** (replaces the flat package list): runtime → exposure → registry →
  substrate → distribution → reference apps, each a one-liner → link to its spoke page.

### Platform layers (positioned as ONE platform, not a catalog)

Each spoke: one-liner + install command + quickstart + docs link. Layers marked *(sox)* live in the
sox-ecosystem repo but are part of the same @adhd platform story.

| Layer | Spoke | Content |
|---|---|---|
| **Runtime** ⭐ | /agent-mcp | Cross-platform agents + prompt components; policy/budget/sanitize plugins; multi-transport via apigen |
| **Exposure** ⭐ | /apigen | TypeScript types → MCP/HTTP/CLI/OpenAPI/Python/gRPC/Java, zero codegen + **"vs tsoa / NestJS / FastAPI"** |
| **Agent registry** | /agent | store-prompts/tools/runtime — agents, skills, prompt components as data |
| **Reference app** | /backlog | Graph-store backlog (CLI + MCP) — the first app proving the substrate |
| **Reference app** | /memory *(sox)* | Bi-temporal graph + hybrid-search agent memory |
| **Substrate** | /sox *(sox)* | graph-store · hybrid-search · vector-store · embeddings |
| **Distribution** | /soxe *(sox)* | Executable extensions + CLI bootstrap |
| **Utilities** | /dispatch · /data · /environment · /workspace · /decompile | Supporting libs (DAG, SQL, config, generators, CLI) |

### Supporting pages

- `/blog` + `/changelog` (release notes)
- `/community` (GitHub, Discussions)
- `/contributing`
- `/showcase` (later)

### Strategic note

Lead with the **platform**, not apigen. The killer pitch is the self-hosting loop — "agents as data,
served from one registry, on one substrate, building itself" (memory `01M1381SYRVGDXNRXXMW8XHBC1`).
The two flagship spokes are **agent-mcp** (runtime/serving) and **apigen** (exposure); apigen is the
most novel single pitch, but the *story* is the platform. Every promotion channel points at the home
page, which points at the layers.

---

## Part 3 — Filesystem layout (proposed)

Static site generated by **Astro + Starlight** (Starlight is already in the stack via
`starlight-llms-txt`). New top-level `site/` directory — **needs repo-root-folder approval** per
the AGENTS.md rule.

```
site/                                        # website source (GH Pages target)
├── package.json
├── astro.config.mjs                         # site config, sitemap, schema plugin
├── src/
│   ├── content/
│   │   └── packages.generated.ts            # AUTO-GENERATED — do not hand-edit (see Part 5)
│   ├── components/
│   │   ├── PackageCard.astro                # one-liner + install + links (driven by manifest)
│   │   └── InstallHero.astro                # install-first hero block
│   └── pages/
│       ├── index.mdx                        # hub: hero + "What's in the stack" (manifest-driven)
│       ├── 404.mdx
│       ├── blog/
│       │   └── index.mdx                    # + posts/*.mdx (release notes)
│       ├── changelog.mdx
│       ├── community.mdx
│       └── [pkg]/                           # per-package spokes (hand-authored docs)
│           ├── apigen/
│           │   ├── index.mdx                # landing (install + quickstart)
│           │   ├── getting-started.mdx
│           │   ├── concepts/*.mdx
│           │   ├── api-reference/*.mdx
│           │   ├── recipes/*.mdx
│           │   └── comparison.mdx           # vs tsoa / NestJS / FastAPI
│           ├── agent-mcp/…   dispatch/…   data/…   environment/…
│           ├── workspace/…    decompile/…  backlog/…
├── public/
│   ├── robots.txt
│   ├── llms.txt                             # generated at build (manifest + hand sections)
│   ├── llms-full.txt
│   ├── favicon.ico
│   ├── CNAME                                 # custom-domain placeholder (see Part 4)
│   └── .well-known/security.txt
├── scripts/
│   ├── generate-packages.mjs                # scan package.json → manifest + llms.txt + sitemap
│   └── verify-sync.mjs                      # CI gate: manifest ≡ publishable packages
└── dist/                                    # build output → deployed to GH Pages
```

---

## Part 4 — URL & hosting placeholders (GitHub Pages to start)

| Placeholder | Value |
|---|---|
| Default URL | `https://PseudoSky.github.io/adhd/` |
| Custom domain | `https://adhd.dev` (or `https://adhd.<tld>`) — add to `public/CNAME` |
| Canonical base | `<site-url>/` — configure once in `astro.config.mjs`, referenced everywhere |

- **Deploy:** `.github/workflows/deploy-site.yml` → build `site/` → `actions/deploy-pages` (branch
  `gh-pages`) or push `site/dist` to the `gh-pages` branch.
- **URL placeholders in docs:** every "Docs" link in package READMEs, `llms.txt`, and `schema.org`
  `url` fields must use the canonical base — grep `SITE_URL` / `https://PseudoSky.github.io/adhd`
  and replace when the custom domain is enabled.

---

## Part 5 — Single source of truth & sync architecture

**Principle: the package list, one-liners, install commands, and links are *derived* from
`package.json` at build time — they can never drift from the actual packages.** Only the
hand-written docs pages are authored by humans.

```
packages/*/*/package.json  +  entrypoint/*/package.json   (description, keywords, name, version, repository)
        │  scripts/generate-packages.mjs (build-time scan)
        ▼
packages.generated.ts  ──── used by ────→  hub "What's in the stack"  (PackageCard)
        │                                  per-package landing metadata (name, install, links)
        ├──→ public/llms.txt + llms-full.txt
        └──→ sitemap.xml
```

- `packages.generated.ts` is committed but marked `@generated — run scripts/generate-packages.mjs`.
- `scripts/verify-sync.mjs` (CI) asserts the manifest's package set exactly equals the publishable
  `@adhd/*` set, and that no package is missing a `description`. Drift fails CI.
- Human-authored per-package docs live in `src/pages/[pkg]/` and only change when the API changes.

---

## Part 6 — Docs that need updating (assume GH Pages)

| File | Update |
|---|---|
| `README.md` (root) | Add "Website" link (`<site-url>`) + a "Packages" table linking to each `/package` page |
| `AGENTS.md` | Add the website policy in Part 7 |
| `CONTRIBUTING.md` | Add a "Website" section (how to add/edit a package page) |
| `PUBLISHING.md` | Add post-publish step: regenerate `packages.generated.ts` + `llms.txt` + changelog page |
| `packages/*/*/README.md` + `entrypoint/*/README.md` | Add `Docs: <site-url>/<package>` link to each |
| `llms.txt` (root) | Keep as repo index; note the **site's** `llms.txt` is the primary AEO file |
| `.github/workflows/deploy-site.yml` | New: build + deploy site |
| `.github/workflows/ci.yml` | Add `verify-sync` + site build check |

---

## Part 7 — Policy updates (keep pages in sync)

Add to `AGENTS.md` (website policy — so agents keep it in sync automatically):

1. **Manifest is derived, never edited.** `site/src/content/packages.generated.ts` is generated from
   `package.json` at build; never hand-edit it.
2. **Description == site one-liner.** A package's `package.json.description` is what the hub card
   shows — so keeping descriptions accurate (see `FEAT-SEO-002…005`) keeps the site accurate.
3. **New package ⇒ site entry + stub docs.** Any new publishable package must also add a stub
   `src/pages/[pkg]/index.mdx` (the hub card auto-appears from the manifest).
4. **CI sync gate.** `verify-sync.mjs` fails the PR if the manifest and the publishable package set
   diverge, or if a package lacks `description`/`keywords`.
5. **Release ⇒ regenerate.** On publish, re-run `generate-packages.mjs` and update the changelog
   page from `CHANGELOG.md` (fold into the deploy workflow).
6. **Flagships get full docs.** agent-mcp (runtime) and apigen (exposure) carry the full Diátaxis
   set; other packages may start as a single landing + one getting-started page.

---

## Part 8 — Follow-up items (checklist)

- [ ] Scaffold `site/` (Astro + Starlight + `starlight-llms-txt`) — needs root-folder approval
- [ ] `scripts/generate-packages.mjs` (scan package.json → manifest + llms.txt + sitemap)
- [ ] Hub `index.mdx` + `PackageCard.astro` + `InstallHero.astro`
- [ ] Flagship docs: agent-mcp (runtime) + apigen (exposure) — getting-started, concepts, api-reference, recipes, comparison
- [ ] Stub the other spokes (`agent`, `dispatch`, `data`, `environment`, `workspace`, `decompile`, `backlog` + the *(sox)* cross-repo links)
- [ ] AEO files: `robots.txt`, `security.txt`, `favicon.ico`, per-package `SoftwareApplication` JSON-LD
- [ ] `deploy-site.yml` + `CNAME` placeholder
- [ ] Update docs per Part 6 (README / AGENTS / CONTRIBUTING / PUBLISHING / per-package READMEs)
- [ ] `verify-sync.mjs` CI gate
- [ ] (later) analytics + Google Search Console verification + SerpBear rank tracking

### Backlog refs

- `FEAT-SEO-006` — docs site (this plan is its spec)
- `FEAT-SEO-001` — GitHub profile — **RESOLVED**
- `FEAT-SEO-002…005` — package metadata — done in source, pending next publish
- `FEAT-SEO-007` / `FEAT-SEO-008` — launch / measurement — dependent on this site

### Memory refs

- Generalized playbook `01M100NC06EXVQSFEBF86KQCJQ`
- @adhd page map `01M100NCDXDC2D01H3WK7VWPSR`
- Website file inventory `01M0ZKJ8VVQF85T8RX9Q2RQ9YP`
- llms.txt standard `01M0ZJA1CF2ZA1MNXKS8ZQ66GE`
- Registry metadata template `01M0ZKJ8VVQF85T8RX9Q2RQ9YN`
- Platform vision `01M1381SYRVGDXNRXXMW8XHBC1` (topic: vision)
- Served-not-installed split `01M1381T6QHVGQ655S1A1KBZY2` (topic: vision)
- Convergence roadmap `01M1381T6QHVGQ655S1A1KBZY3` (topic: vision)

## Confidence

- HIGH — exemplar patterns (live-fetched Rush Stack / Nx / TanStack; Diátaxis is well-established).
- MEDIUM — the adhd page map, the `site/` directory choice, and the exact framework are synthesis
  decisions, not yet validated in the wild. The sync architecture (manifest derived from
  package.json) is the recommended approach and is HIGH-confidence as a design.
