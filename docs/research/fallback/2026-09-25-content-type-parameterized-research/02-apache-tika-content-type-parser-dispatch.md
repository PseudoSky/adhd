---
name: "Apache Tika — content-type detection then typed Parser dispatch (registry of adapters)"
topic: "content-type-parameterization"
tags: ["tool-catalog", "agent:approved", "one-engine-typed-adapters", "content-type-detection", "parser-registry", "prior-art"]
summary: "Tika is a content detection and analysis framework: it identifies a document's content type (MIME) and dispatches to a format-specific Parser implementing a common Parser interface (getSupportedTypes()); AutoDetectParser composes detection + dispatch, and a ContentHandler receives output so downstream code is content-type-agnostic. The registry-of-parsers pattern is the clean L2/extractor shape."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 7
type: production-implementation
data_quality: verified
---

# content

name: Apache Tika — content-type detection then typed Parser dispatch
description: Tika detects and extracts metadata/content from documents. Its architecture is 'detect content type, then dispatch to a typed Parser that implements a common interface'; AutoDetectParser wires detection to the parser registry, and a ContentHandler decouples output consumers from the content type.

features:
  - A common `Parser` interface exposing `getSupportedTypes()`; per-format implementations register the MIME types they handle (PDFParser, EpubParser, RFC822Parser, CryptoParser, …).
  - `AutoDetectParser` = detect-then-dispatch: it determines the content type and invokes the matching parser.
  - A `ContentHandler` receives the structured output, so consumers operate on one uniform stream regardless of content type.
  - Content-type (MIME) is the natural profile key; a new content type = a new Parser implementing the interface, engine unchanged.
use_cases:
  - Profile-driven extraction: MIME type selects the typed adapter; add a content type without forking the pipeline.
  - Detect-then-dispatch profile selection reusable for any heterogeneous-artifact router.
language: Java
quality_signals:
  framework: Apache Tika (Apache Software Foundation)
  deployed_in: "Apache Solr, Nutch, StormCrawler"
  sources_verified: 3
data_quality: verified
metrics_source:
  wikipedia: "search provider wikipedia query 'Apache Tika' — 'Apache Tika is a content detection and analysis framework ... detects and extracts metadata'"
  parser_interface: "search provider google query 'Apache Tika parser interface getSupportedTypes content handler' — tika.apache.org API pages for Parser, PDFParser, EpubParser, RFC822Parser, CryptoParser (per-format implementations)"
  architecture: "search provider google query 'Apache Tika architecture Parser interface content type detection' — (lead); wikipedia deployment note via 'Apache Nutch' / 'StormCrawler' snippets"
tags:
  - tool-catalog
  - agent:approved
  - one-engine-typed-adapters
  - content-type-detection
  - parser-registry
  - prior-art
summary: "Tika = content detection + typed Parser dispatch. A Parser interface (getSupportedTypes) with per-format implementations; AutoDetectParser wires detection to dispatch; ContentHandler makes output content-type-agnostic. The registry-of-parsers pattern is the clean L2/extractor shape for research profiles."

## What the source SAID vs what I INFERRED
- SAID (Wikipedia, retrieved 2026-09-25): "Apache Tika is a content detection and analysis framework, written in Java ... It detects and extracts metadata".
- SAID (tika.apache.org API via Google snippet): existence of the `Parser` interface and per-format parsers (`PDFParser`, `EpubParser`, `RFC822Parser`, `CryptoParser`).
- INFERRED: `AutoDetectParser` and `ContentHandler` are the detection→dispatch and uniform-output halves of the pattern (standard Tika architecture; not directly quoted this run).
- INFERRED: the MIME type is the content-type parameter and the parser registry the adapter set.

## Confidence
- Content detection framework + Parser interface + per-format parsers: **HIGH** (Wikipedia + tika.apache.org API).
- Exact `AutoDetectParser`/`ContentHandler` mechanics: **MEDIUM** (well-known but not directly quoted; fetch backend was down).

## Verdict: ADOPT (adapt)
Borrow "detect profile → dispatch to typed extractor → uniform output contract". Never let the
consumer of findings depend on the content type. Caution: Tika's detection is heuristic (magic
bytes + name) and can misroute — a research pipeline should let the caller *declare* the profile
rather than infer it when the stakes are high.
