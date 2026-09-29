---
name: "Apache UIMA — type-system-driven annotator pipeline (one engine + typed adapters)"
topic: "content-type-parameterization"
tags: ["tool-catalog", "agent:approved", "one-engine-typed-adapters", "type-system", "prior-art", "content-analytics"]
summary: "UIMA (OASIS standard) is the canonical 'one content-agnostic engine + declarative typed profiles'. A Type System descriptor declares the annotations a component produces; a CAS carries the document + typed annotations; pluggable Annotators/Analysis Engines consume/produce them, and engines 'work with any type system' with profile selection by (super-)class white/blacklist. Adopt the pattern for L1/L2; do not adopt the Java framework."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 8
type: production-implementation
data_quality: verified
---

# content

name: Apache UIMA — type-system-driven annotator pipeline
description: UIMA (Unstructured Information Management Architecture, an OASIS standard) separates a content-agnostic analysis engine from a declarative, per-content-type Type System. Components (Annotators) declare the feature-structure types they produce; the Common Analysis Structure (CAS) carries the artifact plus typed annotations; Analysis Engines compose annotators and 'work with any type system'.

features:
  - Declarative Type System declared in XML; the annotator's descriptor includes it so consumers know which types the annotator produces.
  - Common Analysis Structure (CAS): language-independent, programming-language-agnostic data modelling for annotations over an artifact.
  - Analysis Engine = composable annotator collection; engines work with ANY type system; the annotation classes considered can be white- or black-listed by (super-)class — i.e. a profile selects which typed outputs participate.
  - Multiple views of one document (text / video / audio) in one CAS.
  - Built-in scaleout (UIMA-AS).
use_cases:
  - A single analysis runtime parameterized by content-type profiles (the exact L1/L2 split).
  - Selecting which typed findings participate in a given analysis downstream.
language: Java (framework); the type-system concept is language-agnostic
quality_signals:
  standard_body: OASIS
  framework: Apache UIMA (Apache Software Foundation)
  sources_verified: 3
data_quality: verified
metrics_source:
  wikipedia: "search provider wikipedia query 'Unstructured Information Management Architecture' — 'UIMA ... is an OASIS standard for content analytics'"
  architecture: "search provider google query 'UIMA type system CAS annotator analysis engine content' — uima.apache.org tutorials: 'The first step in developing an annotator is to define the CAS Feature Structure types that it creates ... in an XML file'; 'The UIMA type system is part of the analysis engine descriptor file'"
  cas: "search provider google query 'UIMA type system CAS annotator analysis engine content' — ACM: 'CAS supports data modeling via a type system independent of programming language, provides support for creating annotations on text data'"
tags:
  - tool-catalog
  - agent:approved
  - one-engine-typed-adapters
  - type-system
  - prior-art
  - content-analytics
summary: "UIMA (OASIS standard) is the canonical 'one content-agnostic engine + declarative typed profiles'. A Type System descriptor declares annotations; a CAS carries document + typed annotations; pluggable Annotators consume/produce them; engines 'work with any type system' with profile selection by (super-)class. Adopt the architecture; not the Java framework."

## What the source SAID vs what I INFERRED
- SAID (Wikipedia, retrieved 2026-09-25): "UIMA ... is an OASIS standard for content analytics, originally developed [at IBM]".
- SAID (uima.apache.org user docs via Google snippet): "The first step in developing an annotator is to define the CAS Feature Structure types that it creates. This is done in an XML file"; "The UIMA type system is part of the analysis engine descriptor file so that each user or application knows the types the annotator deals with."
- SAID (UIMA-Agreement README via Google snippet): "The engines work with any type system. The annotation classes to be considered can be white- or blacklisted by (super-)class."
- SAID (ACM abstract via Google snippet): "CAS supports data modeling via a type system independent of programming language."
- INFERRED: this is the "one engine + typed adapters" architecture in its most mature form; the Type System is the L2 "profile", and profile-selective participation (white/blacklist) is the L2 plug-in seam.

## Confidence
- Core architecture (type system + CAS + annotators): **HIGH** (≥2 independent sources: Wikipedia + Apache docs + ACM).
- "Profile selection by class white/blacklist" as a deliberate plug-in seam: **MEDIUM** (single source — the UIMA-Agreement README).

## Verdict: ADOPT THE PATTERN (adapt)
Borrow the split — content-agnostic engine / declarative typed profile / typed adapter — for L1 vs L2.
Do NOT adopt the Java framework or its XML-descriptor + generated-classes ceremony, and beware its
schema-on-write pressure (types must be declared up front), which conflicts with schema-on-read
(see file 03).
